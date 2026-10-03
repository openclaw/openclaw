import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import { writeRestartSentinelRowSync } from "../infra/restart-sentinel-store.js";
import * as restartSentinel from "../infra/restart-sentinel.js";
import { readRestartSentinel, writeRestartSentinel } from "../infra/restart-sentinel.js";
import * as legacySource from "../infra/state-migrations.source-snapshot.js";
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
import { scheduleRestartSentinelWakeAfterReady } from "./server-startup-restart-sentinel.js";

const mocks = vi.hoisted(() => ({
  resolveSessionTarget:
    vi.fn<
      typeof import("./session-utils-store-worker.js").resolveGatewaySessionStoreTargetInWorker
    >(),
  portableStateDir: "",
  loadSessionEntry: vi.fn<typeof import("./session-utils.js").loadSessionEntry>(),
  sendDurableMessageBatchCore: vi.fn(async () => ({
    status: "sent" as const,
    results: [{ channel: "matrix" as const, messageId: "synthetic-notice" }],
  })),
  dispatchAssembledChannelTurn: vi.fn(
    async (
      params: Parameters<
        typeof import("../channels/turn/lifecycle.js").dispatchAssembledChannelTurn
      >[0],
    ) => {
      await params.turnAdoptionLifecycle?.onAdopted();
      return { dispatched: true, dispatchResult: { observedReplyDelivery: true } };
    },
  ),
  hookRunner: {
    hasHooks: (name: string) => name === "message_sending",
    runMessageSending: vi.fn(async () => undefined),
  },
}));

vi.mock("@openclaw/fs-safe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe")>();
  const { FsSafeError } = await import("@openclaw/fs-safe/errors");
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const stateRoot = await actual.root(...args);
      if (args[0] === mocks.portableStateDir) {
        vi.spyOn(stateRoot, "move").mockRejectedValue(
          new FsSafeError("helper-unavailable", "unsupported rename", {
            cause: Object.assign(new Error("unsupported rename flags"), { code: "EINVAL" }),
          }),
        );
      }
      return stateRoot;
    },
  };
});

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
vi.mock("./session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: mocks.resolveSessionTarget,
}));

vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>()),
  enqueueSessionEventForHost: vi.fn<
    typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
  >((_text, options) => ({
    id: "restart-state-event",
    cancel: () => true,
    settled: Promise.resolve().then(async () => {
      options.assertCurrent?.();
      await options.onAdopted?.();
      return { status: "completed", executionStarted: true, delivered: false };
    }),
  })),
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
const { startGatewaySidecars } = await import("./server-startup-post-attach.js");
const { resolveGatewaySessionStoreTargetInWorker: realResolveSessionTarget } =
  await vi.importActual<typeof import("./session-utils-store-worker.js")>(
    "./session-utils-store-worker.js",
  );
const sidecars: Array<{ stop: () => void | Promise<void> }> = [];
const gatewayLocks: Array<{ release: () => Promise<void> }> = [];
const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");
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
  mocks.resolveSessionTarget.mockImplementation(async ({ key, agentId, env, assertActive }) => {
    assertActive?.();
    const loaded = mocks.loadSessionEntry(key, { agentId, env });
    return {
      ...loaded,
      store: loaded.entry ? { ...loaded.store, [loaded.canonicalKey]: loaded.entry } : loaded.store,
    };
  });
  mocks.portableStateDir = "";
  setRuntimeConfigSnapshot({ commands: { ownerAllowFrom: ["matrix:!operator:example"] } });
  mocks.loadSessionEntry.mockReturnValue({
    cfg: { commands: { ownerAllowFrom: ["matrix:!operator:example"] } },
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
    const stateDir = tempDirs.make("openclaw-restart-retry-stop-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const pending = await writeRestartSentinel(
      {
        kind: "update",
        status: "skipped",
        ts: 123,
        sessionKey: "agent:main:main",
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

it.each([false, true])(
  "consumes only the captured restart sentinel after preparation changes state root (newer=%s)",
  async (replaceOriginal) => {
    const originalRoot = tempDirs.make("openclaw-restart-startup-original-");
    const unrelatedRoot = tempDirs.make("openclaw-restart-startup-unrelated-");
    const originalEnv = { OPENCLAW_STATE_DIR: originalRoot };
    const unrelatedEnv = { OPENCLAW_STATE_DIR: unrelatedRoot };
    setTestEnvValue("OPENCLAW_STATE_DIR", originalRoot);
    const context = captureDeliveryQueueStateContext();
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: 123,
      sessionKey: "agent:main:main",
      deliveryContext: { channel: "matrix", to: "!operator:example" },
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const original = runOpenClawStateWriteTransaction(
      ({ db }) => writeRestartSentinelRowSync(db, payload),
      { env: originalEnv },
    );
    const unrelated = runOpenClawStateWriteTransaction(
      ({ db }) => writeRestartSentinelRowSync(db, { ...payload, message: "unrelated restart" }),
      { env: unrelatedEnv },
    );
    clock.mockRestore();
    expect(unrelated.revision).toBe(original.revision);
    let retained: Awaited<ReturnType<typeof readRestartSentinel>> = null;
    mocks.hookRunner.runMessageSending.mockImplementationOnce(async () => {
      if (replaceOriginal) {
        retained = await writeRestartSentinel(
          { ...payload, message: "newer restart" },
          originalEnv,
        );
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", unrelatedRoot);
      return undefined;
    });

    await scheduleRestartSentinelWake({ scheduler, signal: scheduler.signal, deps: {} });

    expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
    expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
    expect(await readRestartSentinel(originalEnv)).toEqual(retained);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
    const noticeId = `restart-sentinel-notice:agent:main:main:${original.revision}`;
    expect(await findDeliveryIntentOwner(noticeId, undefined, context)).toMatchObject({
      status: "completed",
    });
    expect(await findDeliveryIntentOwner(noticeId, unrelatedRoot)).toBeNull();
  },
);

it.each(["continuation", "other-handoff", "other-run", "restart", "stopped"] as const)(
  "reconciles only the pending update's terminal snapshot before preparing work (%s)",
  async (replacement) => {
    const originalRoot = tempDirs.make("openclaw-restart-terminal-original-");
    const unrelatedRoot = tempDirs.make("openclaw-restart-terminal-unrelated-");
    const originalEnv = { OPENCLAW_STATE_DIR: originalRoot };
    const unrelatedEnv = { OPENCLAW_STATE_DIR: unrelatedRoot };
    setTestEnvValue("OPENCLAW_STATE_DIR", originalRoot);
    const context = captureDeliveryQueueStateContext();
    const sessionKey = "agent:main:main";
    const run = createUpdateRun({ trigger: "cli", origin: { sessionKey } }, { env: originalEnv });
    const payload = {
      kind: "update" as const,
      status: "skipped" as const,
      ts: 123,
      sessionKey,
      deliveryContext: { channel: "matrix", to: "!operator:example" },
      stats: {
        runId: run.runId,
        handoffId: "synthetic-update-handoff",
        reason: "restart-health-pending",
      },
    };
    await writeRestartSentinel(payload, originalEnv);
    const unrelated = await writeRestartSentinel(
      { kind: "restart", status: "ok", ts: 124, message: "unrelated" },
      unrelatedEnv,
    );
    let retained: Awaited<ReturnType<typeof readRestartSentinel>> = null;
    let terminalRevision = 0;
    let shouldRun = true;
    const readSnapshot = restartSentinel.readRestartSentinel;
    vi.spyOn(restartSentinel, "readRestartSentinel").mockImplementationOnce(async (env) => {
      const pending = await readSnapshot(env);
      retained = await writeRestartSentinel(
        replacement === "restart"
          ? { kind: "restart", status: "ok", ts: 124, message: "newer unrelated restart" }
          : {
              ...payload,
              status: "ok",
              ...(replacement === "continuation"
                ? {
                    continuation: {
                      kind: "agentTurn" as const,
                      message: "Continue after this update.",
                    },
                  }
                : {}),
              stats: {
                runId: replacement === "other-run" ? "unrelated-run" : run.runId,
                handoffId:
                  replacement === "other-handoff" ? "unrelated-handoff" : payload.stats.handoffId,
              },
            },
        originalEnv,
      );
      terminalRevision = retained.revision;
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: originalEnv });
      setTestEnvValue("OPENCLAW_STATE_DIR", unrelatedRoot);
      shouldRun = replacement !== "stopped";
      return pending;
    });
    await scheduleRestartSentinelWake({
      scheduler,
      signal: scheduler.signal,
      deps: {},
      context,
      shouldRun: () => shouldRun,
    });

    if (replacement === "stopped") {
      expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
      expect(
        await findDeliveryIntentOwner(`update-run-finished:${run.runId}`, undefined, context),
      ).toBeNull();
    } else {
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
      expect(
        await findDeliveryIntentOwner(`update-run-finished:${run.runId}`, undefined, context),
      ).toMatchObject({ status: "completed" });
    }
    expect(await readRestartSentinel(originalEnv)).toEqual(
      replacement === "continuation" ? null : retained,
    );
    expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
    expect(
      await findDeliveryIntentOwner(`update-run-finished:${run.runId}`, unrelatedRoot),
    ).toBeNull();
    if (replacement === "continuation") {
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ctxPayload: expect.objectContaining({
            Body: "Continue after this update.",
            MessageSid: `restart-sentinel:agent:main:main:agentTurn:${terminalRevision}`,
          }),
        }),
      );
      await scheduleRestartSentinelWake({ scheduler, signal: scheduler.signal, deps: {}, context });
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledOnce();
    }
  },
);

it.each([
  "portable-claim",
  "late-final",
  "newer-native",
  "consumed-native",
  "stopped",
  "stop-during-import",
] as const)(
  "recovers published legacy update notices through the registered sidecar (%s)",
  async (phase) => {
    const stateDir = tempDirs.make("openclaw-legacy-restart-sidecar-");
    const startsWithFinal = phase === "portable-claim" || phase === "stop-during-import";
    if (phase === "portable-claim") {
      mocks.portableStateDir = stateDir;
    }
    const env = { OPENCLAW_STATE_DIR: stateDir };
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const lock = await acquireGatewayLock({ env, allowInTests: true });
    if (!lock) {
      throw new Error("Expected Gateway lifecycle ownership");
    }
    gatewayLocks.push(lock);
    const context = captureDeliveryQueueStateContext();
    const sourcePath = path.join(stateDir, "restart-sentinel.json");
    const final = {
      kind: "update" as const,
      status: "ok" as const,
      ts: 124,
      sessionKey: "agent:main:main",
      deliveryContext: { channel: "matrix", to: "!operator:example" },
      threadId: "synthetic-thread",
      continuation: { kind: "agentTurn" as const, message: "Continue after the legacy update." },
      stats: { mode: "npm", root: "/synthetic/install", handoffId: "legacy-handoff" },
    };
    const pending = {
      ...final,
      status: "skipped" as const,
      ts: 123,
      continuation: undefined,
      stats: { ...final.stats, reason: "restart-health-pending" },
    };
    await fs.writeFile(
      sourcePath,
      JSON.stringify({ version: 1, payload: startsWithFinal ? final : pending }),
    );
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    if (phase === "stop-during-import") {
      const readSource = legacySource.readLegacyMigrationSourceSnapshot;
      vi.spyOn(legacySource, "readLegacyMigrationSourceSnapshot").mockImplementationOnce(
        async (options) => {
          const snapshot = await readSource(options);
          readStarted.resolve();
          await releaseRead.promise;
          return snapshot;
        },
      );
    }
    const {
      clock,
      scheduler: startupScheduler,
      warn,
      joinWakes,
    } = await startRegisteredSentinel({
      cfg: { commands: { ownerAllowFrom: ["matrix:!operator:example"] } },
      defaultWorkspaceDir: stateDir,
      startChannels: async () => {},
    });
    const advancing = clock.advanceBy(750);
    if (phase === "stop-during-import") {
      await readStarted.promise;
      let joined = false;
      const stopping = Promise.all(
        sidecars.splice(0).map(async (sidecar) => await sidecar.stop()),
      ).then(() => {
        joined = true;
      });
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(joined).toBe(false);
      } finally {
        releaseRead.resolve();
        await advancing;
        await joinWakes();
        await stopping;
      }
      expect(await readRestartSentinel(env)).toMatchObject({ payload: final });
      expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
      expect(mocks.dispatchAssembledChannelTurn).not.toHaveBeenCalled();
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    await advancing;
    await joinWakes();

    let retained: Awaited<ReturnType<typeof readRestartSentinel>> = null;
    if (!startsWithFinal) {
      expect(await readRestartSentinel(env)).toMatchObject({ payload: { status: "skipped" } });
      expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
      if (phase === "newer-native" || phase === "consumed-native") {
        retained = await writeRestartSentinel({ ...pending, message: "New native owner" }, env);
        if (phase === "consumed-native") {
          await restartSentinel.clearRestartSentinelIfRevision(retained.revision, env);
          retained = null;
        }
      } else if (phase === "stopped") {
        retained = await readRestartSentinel(env);
        await Promise.all(sidecars.splice(0).map(async (sidecar) => await sidecar.stop()));
      }
      await fs.writeFile(sourcePath, JSON.stringify({ version: 1, payload: final }));
      await clock.advanceBy(2_000);
      await joinWakes();
    }
    if (startsWithFinal || phase === "late-final") {
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ctxPayload: expect.objectContaining({ Body: final.continuation.message }),
        }),
      );
      expect(await readRestartSentinel(env)).toBeNull();
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      await fs.writeFile(sourcePath, JSON.stringify({ version: 1, payload: final }));
      await scheduleRestartSentinelWake({
        scheduler: startupScheduler,
        signal: startupScheduler.signal,
        deps: {},
        context,
        shouldRun: () => true,
      });
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledOnce();
    } else {
      expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
      expect(mocks.dispatchAssembledChannelTurn).not.toHaveBeenCalled();
      expect(await readRestartSentinel(env)).toEqual(retained);
      expect(JSON.parse(await fs.readFile(sourcePath, "utf8"))).toEqual({
        version: 1,
        payload: final,
      });
    }
    expect(warn).not.toHaveBeenCalled();
  },
);

it.each(["verifying", "terminal-before-marker", "replaced-handoff", "replaced-kind"] as const)(
  "keeps registered pending restart recovery on its original state and session after ambient drift (%s)",
  async (phase) => {
    const originalRoot = tempDirs.make("openclaw-restart-delayed-original-");
    const unrelatedRoot = tempDirs.make("openclaw-restart-delayed-unrelated-");
    const originalEnv = { OPENCLAW_STATE_DIR: originalRoot };
    const unrelatedEnv = { OPENCLAW_STATE_DIR: unrelatedRoot };
    setTestEnvValue("OPENCLAW_STATE_DIR", originalRoot);
    const context = captureDeliveryQueueStateContext();
    const cfg = { commands: { ownerAllowFrom: ["matrix:!operator:example"] } };
    setRuntimeConfigSnapshot(cfg);
    mocks.resolveSessionTarget.mockImplementation(realResolveSessionTarget);
    const sessionKey = "agent:main:main";
    for (const [env, sessionId, to] of [
      [originalEnv, "original-session", "!operator:example"],
      [unrelatedEnv, "unrelated-session", "!unrelated:example"],
    ] as const) {
      await replaceSessionEntry(
        { sessionKey, env },
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
    const run = createUpdateRun({ trigger: "cli", origin: { sessionKey } }, { env: originalEnv });
    if (phase === "verifying") {
      recordUpdateRunPhase(run.runId, "verifying", {}, { env: originalEnv });
    }
    const initialNoticeCount = phase === "verifying" ? 1 : 0;
    const payload = {
      kind: "update" as const,
      status: "skipped" as const,
      ts: 123,
      sessionKey,
      stats: { runId: run.runId, reason: "restart-health-pending" },
    };
    await writeRestartSentinel(payload, originalEnv);
    const unrelated = await writeRestartSentinel(
      { kind: "restart", status: "ok", ts: 124, message: "unrelated" },
      unrelatedEnv,
    );
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "");
    const {
      clock,
      scheduler: recoveryScheduler,
      warn,
      joinWakes,
    } = await startRegisteredSentinel({
      cfg,
      defaultWorkspaceDir: originalRoot,
      startChannels: async () => {
        setTestEnvValue("OPENCLAW_STATE_DIR", unrelatedRoot);
      },
    });
    setTestEnvValue("OPENCLAW_STATE_DIR", unrelatedRoot);
    expect(recoveryScheduler.nextWakeAtMs).toBe(750);
    await clock.advanceBy(750);
    expect(getUpdateRun(run.runId, { env: originalEnv })?.verification.booted).toBe(true);
    expect(await readRestartSentinel(originalEnv)).not.toBeNull();
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
    expect(recoveryScheduler.nextWakeAtMs).toBe(2_750);
    finishUpdateRun(run.runId, { status: "succeeded" }, { env: originalEnv });
    if (phase === "replaced-handoff" || phase === "replaced-kind") {
      const replacement = await writeRestartSentinel(
        phase === "replaced-kind"
          ? { kind: "restart", status: "ok", ts: 124, message: "newer restart" }
          : {
              ...payload,
              status: "ok",
              stats: { runId: run.runId, handoffId: "newer-handoff" },
            },
        originalEnv,
      );
      await clock.advanceBy(2_000);
      await joinWakes();
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
      expect(await readRestartSentinel(originalEnv)).toEqual(replacement);
      expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
      return;
    }
    if (phase === "terminal-before-marker") {
      await clock.advanceBy(2_000);
      await joinWakes();
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
      expect(await readRestartSentinel(originalEnv)).not.toBeNull();
    }
    await writeRestartSentinel(
      { ...payload, status: "ok", stats: { runId: run.runId } },
      originalEnv,
    );
    await clock.advanceBy(2_000);
    await joinWakes();
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount + 1);
    expect(getUpdateRun(run.runId, { env: originalEnv })?.verification.noticeDelivered).toBe(true);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "!operator:example",
        session: expect.objectContaining({ key: sessionKey }),
      }),
      undefined,
      expect.objectContaining({ stateDir: originalRoot }),
    );
    const selected = await mocks.resolveSessionTarget.mock.results.at(-1)?.value;
    expect(selected?.store[selected.canonicalKey]?.sessionId).toBe("original-session");
    expect(await readRestartSentinel(originalEnv)).toBeNull();
    expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
    expect(
      await findDeliveryIntentOwner(`update-run-finished:${run.runId}`, undefined, context),
    ).toMatchObject({ status: "completed" });
    expect(
      await findDeliveryIntentOwner(`update-run-finished:${run.runId}`, unrelatedRoot),
    ).toBeNull();
    expect(getUpdateRun(run.runId, { env: unrelatedEnv })).toBeUndefined();
    if (phase === "verifying") {
      expect(getUpdateRun(run.runId, { env: originalEnv })?.steps).toContainEqual(
        expect.objectContaining({ step: "notice:verifying", status: "completed" }),
      );
    }
    expect(warn).not.toHaveBeenCalled();
  },
);

it("leaves durable notices queued when the Gateway stops during sentinel consumption", async () => {
  const stateDir = tempDirs.make("openclaw-restart-consume-stop-");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  const context = captureDeliveryQueueStateContext();
  const sentinel = await writeRestartSentinel({
    kind: "restart",
    status: "ok",
    ts: 123,
    sessionKey: "agent:main:main",
    deliveryContext: { channel: "matrix", to: "!operator:example" },
  });
  const controller = new AbortController();
  const clear = restartSentinel.clearRestartSentinelIfRevision;
  vi.spyOn(restartSentinel, "clearRestartSentinelIfRevision").mockImplementationOnce(
    async (...args) => {
      const consumed = await clear(...args);
      controller.abort();
      return consumed;
    },
  );
  await scheduleRestartSentinelWake({ scheduler, signal: controller.signal, deps: {}, context });
  expect(await readRestartSentinel()).toBeNull();
  expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
  expect(mocks.dispatchAssembledChannelTurn).not.toHaveBeenCalled();
  expect(
    await findDeliveryIntentOwner(
      `restart-sentinel-notice:agent:main:main:${sentinel.revision}`,
      undefined,
      context,
    ),
  ).toMatchObject({ status: "pending" });
});
