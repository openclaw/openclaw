import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type * as SessionEvents from "../auto-reply/reply/session-event-handoff.js";
import type * as ChannelTurn from "../channels/turn/lifecycle.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { getRuntimeConfig } from "../config/io.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import { writeRestartSentinelRowSync } from "../infra/restart-sentinel-store.js";
import * as restartSentinel from "../infra/restart-sentinel.js";
import {
  readRestartSentinel,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "../infra/restart-sentinel.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../infra/update-run-ledger.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { configureRestartSessionEventMocks } from "./server-restart-sentinel.test-support.js";
import { scheduleRestartSentinelWakeAfterReady } from "./server-startup-restart-sentinel.js";
import type { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import type * as SessionWorker from "./session-utils-store-worker.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntryAsync: vi.fn<typeof loadSessionEntryAsync>(),
  resolveSessionTarget: vi.fn<typeof SessionWorker.resolveGatewaySessionStoreTargetInWorker>(),
  captureSessionEventTarget: vi.fn<typeof SessionEvents.captureSessionEventTargetForHost>(),
  enqueueSessionEvent: vi.fn<typeof SessionEvents.enqueueSessionEventForHost>(),
  sendDurableMessageBatchCore: vi.fn(async () => ({
    status: "sent" as const,
    results: [{ channel: "matrix" as const, messageId: "synthetic-notice" }],
  })),
  dispatchAssembledChannelTurn: vi.fn(
    async (params: Parameters<typeof ChannelTurn.dispatchAssembledChannelTurn>[0]) => {
      await params.turnAdoptionLifecycle?.onAdopted();
      return { dispatched: true, dispatchResult: { observedReplyDelivery: true } };
    },
  ),
  hookRunner: {
    hasHooks: (name: string) => name === "message_sending",
    runMessageSending: vi.fn(async () => undefined),
  },
}));

// mock-isolation: Keep real entry reads for the state-custody cases; stub target selection.
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionWorker>()),
  loadGatewaySessionEntryReadOnlyInWorker: async ({
    key,
    agentId,
    env,
  }: Parameters<typeof SessionWorker.loadGatewaySessionEntryReadOnlyInWorker>[0]) =>
    mocks.loadSessionEntryAsync(key, { agentId, env }),
  resolveGatewaySessionStoreTargetInWorker: mocks.resolveSessionTarget,
}));
// mock-isolation: The state-context suite observes adoption without executing a model turn.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.captureSessionEventTarget,
  enqueueSessionEventForHost: mocks.enqueueSessionEvent,
}));
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: mocks.sendDurableMessageBatchCore,
}));
vi.mock("../channels/turn/lifecycle.js", () => ({
  dispatchAssembledChannelTurn: mocks.dispatchAssembledChannelTurn,
}));
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

vi.mock("../hooks/loader.js", () => ({
  prepareInternalHooks: async () => ({ loadedCount: 0, commit: () => true }),
}));
vi.mock("../hooks/internal-hooks.js", () => ({ hasInternalHookListeners: () => false }));
vi.mock("../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markStartupOrphanedMainSessionsForRecovery: async () => ({ marked: 0, skipped: 0 }),
}));
vi.mock("./server-startup-model-runtime.js", () => ({
  publishConfiguredModelRuntimeSnapshots: async () => {},
  hydrateConfiguredExternalCliAuth: async () => ({}),
}));
vi.mock("../auto-reply/reply/dispatch-from-config.runtime-loaders.js", () => ({
  loadGetReplyFromConfigRuntime: async () => ({ prewarmConfigDrivenReplyRuntime: async () => {} }),
}));
const { startGatewaySidecars } = await import("./server-startup-sidecars.js");
const sessionWorker = await vi.importActual<typeof SessionWorker>(
  "./session-utils-store-worker.js",
);
const realLoadSessionEntry: typeof loadSessionEntryAsync = (key, opts) =>
  sessionWorker.loadGatewaySessionEntryReadOnlyInWorker({
    cfg: getRuntimeConfig(),
    key,
    ...opts,
    excludeInternalEffects: true,
    readOnly: false,
  });
const sidecars: Array<{ stop: () => void | Promise<void> }> = [];
const gatewayLocks: Array<{ release: () => Promise<void> }> = [];
const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");
const ownerConfig = { commands: { ownerAllowFrom: ["matrix:!operator:example"] } };
const sessionKey = "agent:main:main";
const deliveryContext = { channel: "matrix", to: "!operator:example" };
const restartPayload = (
  overrides: Partial<RestartSentinelPayload> = {},
): RestartSentinelPayload => ({
  kind: "restart",
  status: "ok",
  ts: 123,
  sessionKey,
  deliveryContext,
  ...overrides,
});
type Sentinel = Awaited<ReturnType<typeof readRestartSentinel>>;
function stateRoot() {
  const root = tempDirs.make("openclaw-restart-state-");
  const env = { OPENCLAW_STATE_DIR: root };
  return {
    root,
    env,
    read: () => readRestartSentinel(env),
    write: (payload: RestartSentinelPayload) => writeRestartSentinel(payload, env),
  };
}
function statePair() {
  const state = stateRoot();
  setTestEnvValue("OPENCLAW_STATE_DIR", state.root);
  return { ...state, other: stateRoot(), context: captureDeliveryQueueStateContext() };
}
function pendingPayload(runId: string, stats: RestartSentinelPayload["stats"] = {}) {
  return {
    kind: "update" as const,
    status: "skipped" as const,
    ts: 123,
    sessionKey,
    stats: { runId, reason: "restart-health-pending", ...stats },
  };
}
const unrelatedPayload: RestartSentinelPayload = {
  kind: "restart",
  status: "ok",
  ts: 124,
  message: "unrelated",
};
async function expectStatePair(
  state: ReturnType<typeof statePair>,
  original: Sentinel,
  unrelated: Sentinel,
) {
  expect([await state.read(), await state.other.read()]).toEqual([original, unrelated]);
}
async function expectNoticeOwner(
  state: ReturnType<typeof statePair>,
  id: string,
  status: "completed" | "pending" | null,
) {
  const owner = await findDeliveryIntentOwner(id, undefined, state.context);
  expect([owner, await findDeliveryIntentOwner(id, state.other.root)]).toEqual([
    status === null ? null : expect.objectContaining({ status }),
    null,
  ]);
}
function expectNoDelivery() {
  expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
  expect(mocks.dispatchAssembledChannelTurn).not.toHaveBeenCalled();
}
function wake(overrides: Partial<Parameters<typeof scheduleRestartSentinelWake>[0]> = {}) {
  return scheduleRestartSentinelWake({
    scheduler,
    signal: scheduler.signal,
    deps: {},
    ...overrides,
  });
}
let envSnapshot: ReturnType<typeof captureEnv>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map(async (sidecar) => await sidecar.stop()));
    for (const lock of gatewayLocks.splice(0)) {
      await lock.release();
    }
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
    resetConfigRuntimeState();
    await closeOpenClawStateDatabaseAsync();
    resetPluginRuntimeStateForTest();
    resetGatewayWorkAdmission();
    resetSystemEventsForTest();
    vi.restoreAllMocks();
    envSnapshot.restore();
    cleanup();
  });
});

beforeEach(() => {
  scheduler = createTestGatewayScheduler();
  sidecars.push(scheduler);
  envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_SUPERVISOR_MODE",
    "VITEST",
    "NODE_ENV",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
  ]);
  setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "");
  vi.clearAllMocks();
  setRuntimeConfigSnapshot(ownerConfig);
  configureRestartSessionEventMocks(mocks, "synthetic-session");
  mocks.loadSessionEntryAsync.mockResolvedValue({
    cfg: ownerConfig,
    agentId: "main",
    entry: { sessionId: "synthetic-session", updatedAt: 1 },
    store: {},
    storePath: "/synthetic/openclaw-agent.sqlite",
    canonicalKey: "agent:main:main",
    storeKeys: ["agent:main:main"],
    legacyKey: undefined,
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "matrix",
          outbound: createDirectOutboundTestAdapter({ channel: "matrix" }),
        }),
      },
    ]),
  );
});

async function startRegisteredSentinel(
  params: Pick<
    Parameters<typeof startGatewaySidecars>[0],
    "cfg" | "defaultWorkspaceDir" | "startChannels"
  >,
) {
  const startupCompleted = createDeferred();
  const wakeTasks: Promise<unknown>[] = [];
  const runWithAdmission = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
  vi.spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission").mockImplementation(
    (callback, origin, signal) => {
      const work = runWithAdmission(callback, origin, signal);
      if (origin === "startup:sidecars.restart-sentinel") {
        void work.then(() => startupCompleted.resolve(), startupCompleted.reject);
      }
      if (origin === "restart-sentinel:wake") {
        wakeTasks.push(work);
      }
      return work;
    },
  );
  const testMode = captureEnv(["VITEST", "NODE_ENV"]);
  const clock = createGatewaySchedulerClock();
  const sidecarScheduler = createTestGatewayScheduler(clock.clock);
  sidecars.push(sidecarScheduler);
  setTestEnvValue("VITEST", "");
  setTestEnvValue("NODE_ENV", "production");
  const warn = vi.fn();
  try {
    await startGatewaySidecars({
      trackStartupWork: (run) => run(new AbortController().signal),
      ...params,
      scheduler: sidecarScheduler,
      deps: {},
      pluginRegistry: createTestRegistry([]),
      shouldStartPluginServices: () => false,
      log: { warn },
      logHooks: { info: vi.fn(), warn, error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      onPostReadySidecars: (...registered) => sidecars.push(...registered),
    });
    await startupCompleted.promise;
  } finally {
    testMode.restore();
  }
  return { clock, scheduler: sidecarScheduler, warn, joinWakes: () => Promise.all(wakeTasks) };
}

it.each(["queued", "running", "admission"] as const)(
  "stops pending update recovery and joins its retry (%s)",
  async (phase) => {
    const { root, env } = stateRoot();
    setTestEnvValue("OPENCLAW_STATE_DIR", root);
    const pending = await writeRestartSentinel(
      {
        ...pendingPayload(""),
        stats: { handoffId: "pending-handoff", reason: "managed-service-handoff-started" },
      },
      env,
    );
    const readSnapshot = restartSentinel.readRestartSentinel;
    const read = vi.spyOn(restartSentinel, "readRestartSentinel");
    const clear = vi.spyOn(restartSentinel, "clearRestartSentinelIfRevision");
    const clock = createGatewaySchedulerClock();
    const retryScheduler = createTestGatewayScheduler(clock.clock);
    const sidecar = scheduleRestartSentinelWakeAfterReady({
      scheduler: retryScheduler,
      deps: {},
      log: { warn: vi.fn() },
    });
    sidecars.push(retryScheduler, sidecar);
    await clock.advanceBy(750);
    expect(retryScheduler.nextWakeAtMs).toBe(2_750);
    const readsBeforeRetry = read.mock.calls.length;
    const readStarted = createDeferred();
    const releaseRead = createDeferred<typeof pending>();
    if (phase === "running") {
      read.mockImplementationOnce(() => {
        readStarted.resolve();
        return releaseRead.promise;
      });
    }
    const suspension =
      phase === "admission" ? gatewayWorkAdmission.tryBeginGatewaySuspendAdmission(() => {}) : null;
    if (phase === "admission") {
      expect(suspension?.commit()).toBe(true);
    }
    const retry = phase === "queued" ? undefined : clock.advanceBy(2_000);
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      if (phase === "running") {
        await readStarted.promise;
      }
      stopping = Promise.resolve(sidecar.stop()).then(() => {
        stopped = true;
      });
      if (phase === "running") {
        // The initial startup timer has settled; only this retry can hold stop open.
        for (let turn = 0; turn < 5; turn += 1) {
          await Promise.resolve();
        }
        expect(stopped).toBe(false);
      }
    } finally {
      releaseRead.resolve(pending);
      await stopping;
      await retry;
      suspension?.release();
      await sidecar.stop();
    }
    await clock.advanceBy(2_000);
    expect(retryScheduler.nextWakeAtMs).toBeNull();
    expect(read).toHaveBeenCalledTimes(readsBeforeRetry + (phase === "running" ? 1 : 0));
    expect(clear).not.toHaveBeenCalled();
    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(await readSnapshot(env)).toEqual(pending);
  },
);

it.each([
  { filename: "restart-sentinel.json", startup: false },
  { filename: "restart-sentinel.json.doctor-importing", startup: false },
  { filename: "restart-sentinel.json", startup: true },
  { filename: "restart-sentinel.json.doctor-importing", startup: true },
])(
  "refuses retired $filename without consuming canonical state (startup=$startup)",
  async ({ filename, startup }) => {
    const { root, env } = stateRoot();
    setTestEnvValue("OPENCLAW_STATE_DIR", root);
    let retained: Sentinel = null;
    if (!startup) {
      const lock = await acquireGatewayLock({ env, allowInTests: true });
      if (!lock) {
        throw new Error("Expected Gateway lifecycle ownership");
      }
      gatewayLocks.push(lock);
      retained = await writeRestartSentinel(
        restartPayload({ message: "Retained canonical notice" }),
        env,
      );
    }
    const sourcePath = path.join(root, filename);
    const source = JSON.stringify({
      version: 1,
      payload: { kind: "update", status: "ok", ts: 124, stats: { mode: "npm" } },
    });
    await fs.writeFile(sourcePath, source);
    await expect(
      startup
        ? startRegisteredSentinel({
            cfg: {},
            defaultWorkspaceDir: root,
            startChannels: async () => {},
          })
        : wake({ context: captureDeliveryQueueStateContext(), shouldRun: () => true }),
    ).rejects.toThrow('Run "openclaw doctor --fix" to migrate or archive them, then retry.');
    expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
    expect(await readRestartSentinel(env)).toEqual(retained);
    expectNoDelivery();
  },
);

it.each([false, true])(
  "consumes only the captured restart sentinel after preparation changes state root (newer=%s)",
  async (replaceOriginal) => {
    const state = statePair();
    const payload = restartPayload();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const original = runOpenClawStateWriteTransaction(
      ({ db }) => writeRestartSentinelRowSync(db, payload),
      { env: state.env },
    );
    const unrelated = runOpenClawStateWriteTransaction(
      ({ db }) => writeRestartSentinelRowSync(db, { ...payload, message: "unrelated restart" }),
      { env: state.other.env },
    );
    clock.mockRestore();
    expect(unrelated.revision).toBe(original.revision);
    let retained: Sentinel = null;
    mocks.hookRunner.runMessageSending.mockImplementationOnce(async () => {
      if (replaceOriginal) {
        retained = await state.write({ ...payload, message: "newer restart" });
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", state.other.root);
      return undefined;
    });

    await wake();

    expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
    await expectStatePair(state, retained, unrelated);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
    const noticeId = `restart-sentinel-notice:agent:main:main:${original.revision}`;
    await expectNoticeOwner(state, noticeId, "completed");
  },
);

it.each(["continuation", "other-handoff", "other-run", "restart", "stopped"] as const)(
  "reconciles only the pending update's terminal snapshot before preparing work (%s)",
  async (replacement) => {
    const state = statePair();
    const { env, context } = state;
    const run = createUpdateRun({ trigger: "cli", origin: { sessionKey } }, { env });
    const payload = {
      ...pendingPayload(run.runId, { handoffId: "synthetic-update-handoff" }),
      deliveryContext,
    };
    await state.write(payload);
    const unrelated = await state.other.write(unrelatedPayload);
    let retained: Sentinel = null;
    let terminalRevision = 0;
    let shouldRun = true;
    const readSnapshot = restartSentinel.readRestartSentinel;
    vi.spyOn(restartSentinel, "readRestartSentinel").mockImplementationOnce(async (readEnv) => {
      const pending = await readSnapshot(readEnv);
      retained = await state.write(
        replacement === "restart"
          ? { kind: "restart", status: "ok", ts: 124, message: "newer unrelated restart" }
          : {
              ...payload,
              status: "ok",
              continuation:
                replacement === "continuation"
                  ? { kind: "agentTurn", message: "Continue after this update." }
                  : undefined,
              stats: {
                runId: replacement === "other-run" ? "unrelated-run" : run.runId,
                handoffId:
                  replacement === "other-handoff" ? "unrelated-handoff" : payload.stats.handoffId,
              },
            },
      );
      terminalRevision = retained.revision;
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
      setTestEnvValue("OPENCLAW_STATE_DIR", state.other.root);
      shouldRun = replacement !== "stopped";
      return pending;
    });
    await wake({ context, shouldRun: () => shouldRun });

    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(
      replacement === "stopped" ? 0 : 1,
    );
    await expectStatePair(state, replacement === "continuation" ? null : retained, unrelated);
    await expectNoticeOwner(
      state,
      `update-run-finished:${run.runId}`,
      replacement === "stopped" ? null : "completed",
    );
    if (replacement === "continuation") {
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ctxPayload: expect.objectContaining({
            Body: "Continue after this update.",
            MessageSid: `restart-sentinel:agent:main:main:agentTurn:${terminalRevision}`,
          }),
        }),
      );
      await wake({ context });
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledOnce();
    }
  },
);

it.each(["verifying", "terminal-before-marker", "replaced-handoff", "replaced-kind"] as const)(
  "keeps registered pending restart recovery on its original state and session after ambient drift (%s)",
  async (phase) => {
    const state = statePair();
    const { env, root, other } = state;
    mocks.loadSessionEntryAsync.mockImplementation(realLoadSessionEntry);
    for (const [sessionEnv, sessionId, to] of [
      [env, "original-session", "!operator:example"],
      [other.env, "unrelated-session", "!unrelated:example"],
    ] as const) {
      await replaceSessionEntry(
        { sessionKey, env: sessionEnv },
        {
          sessionId,
          updatedAt: 1,
          delivery: {
            kind: "external",
            route: { channel: "matrix", target: { to, chatType: "direct" } },
            context: { channel: "matrix", to },
            origin: { provider: "matrix", to, chatType: "direct" },
          },
        },
      );
    }
    const run = createUpdateRun({ trigger: "cli", origin: { sessionKey } }, { env });
    if (phase === "verifying") {
      recordUpdateRunPhase(run.runId, "verifying", {}, { env });
    }
    const initialNoticeCount = phase === "verifying" ? 1 : 0;
    const payload = pendingPayload(run.runId);
    await state.write(payload);
    const unrelated = await other.write(unrelatedPayload);
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "");
    const {
      clock,
      scheduler: recoveryScheduler,
      warn,
      joinWakes,
    } = await startRegisteredSentinel({
      cfg: ownerConfig,
      defaultWorkspaceDir: root,
      startChannels: async () => {
        setTestEnvValue("OPENCLAW_STATE_DIR", other.root);
      },
    });
    setTestEnvValue("OPENCLAW_STATE_DIR", other.root);
    expect(recoveryScheduler.nextWakeAtMs).toBe(750);
    await clock.advanceBy(750);
    expect(getUpdateRun(run.runId, { env })?.verification.booted).toBe(true);
    expect(await state.read()).not.toBeNull();
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
    expect(recoveryScheduler.nextWakeAtMs).toBe(2_750);
    finishUpdateRun(run.runId, { status: "succeeded" }, { env });
    if (phase === "replaced-handoff" || phase === "replaced-kind") {
      const replacement = await state.write(
        phase === "replaced-kind"
          ? { kind: "restart", status: "ok", ts: 124, message: "newer restart" }
          : {
              ...payload,
              status: "ok",
              stats: { runId: run.runId, handoffId: "newer-handoff" },
            },
      );
      await retry();
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
      await expectStatePair(state, replacement, unrelated);
      return;
    }
    if (phase === "terminal-before-marker") {
      await retry();
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
      expect(await state.read()).not.toBeNull();
    }
    await state.write({ ...payload, status: "ok", stats: { runId: run.runId } });
    await retry();
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount + 1);
    expect(getUpdateRun(run.runId, { env })?.verification.noticeDelivered).toBe(true);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "!operator:example",
        session: expect.objectContaining({ key: sessionKey }),
      }),
      undefined,
      expect.objectContaining({ stateDir: root }),
    );
    expect((await mocks.loadSessionEntryAsync.mock.results.at(-1)?.value)?.entry?.sessionId).toBe(
      "original-session",
    );
    await expectStatePair(state, null, unrelated);
    await expectNoticeOwner(state, `update-run-finished:${run.runId}`, "completed");
    expect(getUpdateRun(run.runId, { env: other.env })).toBeUndefined();
    if (phase === "verifying") {
      expect(getUpdateRun(run.runId, { env })?.steps).toContainEqual(
        expect.objectContaining({ step: "notice:verifying", status: "completed" }),
      );
    }
    expect(warn).not.toHaveBeenCalled();
    async function retry() {
      await clock.advanceBy(2_000);
      await joinWakes();
    }
  },
);

it("leaves durable notices queued when the Gateway stops during sentinel consumption", async () => {
  const { root } = stateRoot();
  setTestEnvValue("OPENCLAW_STATE_DIR", root);
  const context = captureDeliveryQueueStateContext();
  const sentinel = await writeRestartSentinel(restartPayload());
  const controller = new AbortController();
  const clear = restartSentinel.clearRestartSentinelIfRevision;
  vi.spyOn(restartSentinel, "clearRestartSentinelIfRevision").mockImplementationOnce(
    async (...args) => {
      const consumed = await clear(...args);
      controller.abort();
      return consumed;
    },
  );
  await wake({ context, signal: controller.signal });
  expect(await readRestartSentinel()).toBeNull();
  expectNoDelivery();
  expect(
    await findDeliveryIntentOwner(
      `restart-sentinel-notice:agent:main:main:${sentinel.revision}`,
      undefined,
      context,
    ),
  ).toMatchObject({ status: "pending" });
});
