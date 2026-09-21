import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import * as restartSentinel from "../infra/restart-sentinel.js";
import { readRestartSentinel, writeRestartSentinel } from "../infra/restart-sentinel.js";
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
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
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

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: vi.fn(),
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
const { loadSessionEntry: realLoadSessionEntry } =
  await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
const sidecars: Array<{ stop: () => void | Promise<void> }> = [];
const { scheduleRestartSentinelWake, refreshLatestUpdateRestartSentinel } =
  await import("./server-restart-sentinel.js");
let envSnapshot: ReturnType<typeof captureEnv>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map(async (sidecar) => await sidecar.stop()));
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
    const original = await writeRestartSentinel(payload, originalEnv);
    const unrelated = await writeRestartSentinel(
      { ...payload, message: "unrelated restart" },
      unrelatedEnv,
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

    await scheduleRestartSentinelWake({ deps: {} });

    expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
    expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
    expect(await readRestartSentinel(originalEnv)).toEqual(retained);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
    const noticeId = `restart-sentinel-notice:agent:main:main:${original.revision}`;
    expect(findDeliveryIntentOwner(noticeId, undefined, context)).toMatchObject({
      status: "completed",
    });
    expect(findDeliveryIntentOwner(noticeId, unrelatedRoot)).toBeNull();
  },
);

it.each([
  "same",
  "continuation",
  "other-handoff",
  "other-run",
  "restart",
  "replaced-again",
  "stopped",
] as const)(
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
    if (replacement === "replaced-again") {
      mocks.hookRunner.runMessageSending.mockImplementationOnce(async () => {
        retained = await writeRestartSentinel(
          { kind: "restart", status: "ok", ts: 125, message: "replacement after reconciliation" },
          originalEnv,
        );
        return undefined;
      });
    }

    await scheduleRestartSentinelWake({ deps: {}, context, shouldRun: () => shouldRun });

    if (replacement === "stopped") {
      expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
      expect(
        findDeliveryIntentOwner(`update-run-finished:${run.runId}`, undefined, context),
      ).toBeNull();
    } else {
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
      expect(
        findDeliveryIntentOwner(`update-run-finished:${run.runId}`, undefined, context),
      ).toMatchObject({ status: "completed" });
    }
    expect(await readRestartSentinel(originalEnv)).toEqual(
      replacement === "same" || replacement === "continuation" ? null : retained,
    );
    expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
    expect(findDeliveryIntentOwner(`update-run-finished:${run.runId}`, unrelatedRoot)).toBeNull();
    if (replacement === "continuation") {
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ctxPayload: expect.objectContaining({
            Body: "Continue after this update.",
            MessageSid: `restart-sentinel:agent:main:main:agentTurn:${terminalRevision}`,
          }),
        }),
      );
      await scheduleRestartSentinelWake({ deps: {}, context });
      expect(mocks.dispatchAssembledChannelTurn).toHaveBeenCalledOnce();
    }
  },
);

it("does not rewrite pending update sentinels during status refresh", async () => {
  const originalEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-restart-status-") };
  const sentinel = await writeRestartSentinel(
    {
      kind: "update",
      status: "skipped",
      ts: 123,
      stats: { mode: "git", handoffId: "handoff-1", reason: "managed-service-handoff-started" },
    },
    originalEnv,
  );

  await expect(refreshLatestUpdateRestartSentinel(originalEnv)).resolves.toEqual(sentinel.payload);

  expect(await readRestartSentinel(originalEnv)).toEqual(sentinel);
});

it.each([
  "requested",
  "verifying",
  "stopped",
  "terminal-before-marker",
  "replaced-handoff",
  "replaced-kind",
] as const)(
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
    mocks.loadSessionEntry.mockImplementation(realLoadSessionEntry);
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
    const warn = vi.fn();
    const startupCompleted = createDeferred();
    const runWithAdmission = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
    const admittedWork = vi
      .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
      .mockImplementation((callback, origin, signal) => {
        const work = runWithAdmission(callback, origin, signal);
        if (origin === "startup:sidecars.restart-sentinel") {
          void work.then(() => startupCompleted.resolve(), startupCompleted.reject);
        }
        return work;
      });
    const testMode = captureEnv(["VITEST", "NODE_ENV"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setTestEnvValue("VITEST", "");
    setTestEnvValue("NODE_ENV", "production");
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "");
    await startGatewaySidecars({
      cfg,
      defaultWorkspaceDir: originalRoot,
      deps: {},
      pluginRegistry: createTestRegistry([]),
      startChannels: async () => {
        setTestEnvValue("OPENCLAW_STATE_DIR", unrelatedRoot);
      },
      shouldStartPluginServices: () => false,
      log: { warn },
      logHooks: { info: vi.fn(), warn, error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      onPostReadySidecars: (...registered) => {
        sidecars.push(...registered);
      },
    });
    setTestEnvValue("OPENCLAW_STATE_DIR", unrelatedRoot);
    await startupCompleted.promise;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    testMode.restore();
    await vi.advanceTimersByTimeAsync(750);
    await admittedWork.mock.results.at(-1)?.value;
    expect(getUpdateRun(run.runId, { env: originalEnv })?.verification.booted).toBe(true);
    expect(await readRestartSentinel(originalEnv)).not.toBeNull();
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    finishUpdateRun(run.runId, { status: "succeeded" }, { env: originalEnv });
    if (phase === "stopped") {
      await Promise.all(sidecars.splice(0).map(async (sidecar) => await sidecar.stop()));
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
      expect(await readRestartSentinel(originalEnv)).not.toBeNull();
      expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
      return;
    }
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
      await vi.advanceTimersByTimeAsync(1);
      await admittedWork.mock.results.at(-1)?.value;
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
      expect(await readRestartSentinel(originalEnv)).toEqual(replacement);
      expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
      return;
    }
    if (phase === "terminal-before-marker") {
      await vi.advanceTimersByTimeAsync(1);
      await admittedWork.mock.results.at(-1)?.value;
      expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(initialNoticeCount);
      expect(await readRestartSentinel(originalEnv)).not.toBeNull();
    }
    await writeRestartSentinel(
      { ...payload, status: "ok", stats: { runId: run.runId } },
      originalEnv,
    );
    await vi.advanceTimersByTimeAsync(1);
    await admittedWork.mock.results.at(-1)?.value;
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
    expect(mocks.loadSessionEntry.mock.results.at(-1)?.value.entry.sessionId).toBe(
      "original-session",
    );
    expect(await readRestartSentinel(originalEnv)).toBeNull();
    expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
    expect(
      findDeliveryIntentOwner(`update-run-finished:${run.runId}`, undefined, context),
    ).toMatchObject({ status: "completed" });
    expect(findDeliveryIntentOwner(`update-run-finished:${run.runId}`, unrelatedRoot)).toBeNull();
    expect(getUpdateRun(run.runId, { env: unrelatedEnv })).toBeUndefined();
    if (phase === "verifying") {
      expect(getUpdateRun(run.runId, { env: originalEnv })?.steps).toContainEqual(
        expect.objectContaining({ step: "notice:verifying", status: "completed" }),
      );
    }
    expect(warn).not.toHaveBeenCalled();
  },
);
