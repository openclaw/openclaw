import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../agents/subagents/swarm/swarm-scheduler.js";
import { registerDispatcher } from "../auto-reply/reply/dispatcher-registry.js";
import {
  createReplyOperation,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { InternalHookEvent } from "../hooks/internal-hooks.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS } from "../plugins/services.js";
import {
  createServiceRegistration,
  startPluginServices,
} from "../plugins/services.test-support.js";
import type { OpenClawPluginService } from "../plugins/types.js";
import { getProcessSupervisor, type ManagedRun } from "../process/supervisor/index.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  createGatewayCloseTestDepsFactory,
  createGatewayCloseTestHandlerFactory,
  type GatewayCloseParams,
  createTestChatRunState,
} from "./server-close.test-support.js";

type TriggerInternalHookMock = (event: InternalHookEvent) => Promise<void>;

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  listChannelPlugins: vi.fn((): Array<{ id: "telegram" | "discord" }> => []),
  disposeAllCodeModeRuns: vi.fn(),
  disposeAgentHarnesses: vi.fn<() => Promise<void>>(async () => undefined),
  closeProviderTransportDispatcherPool: vi.fn(async () => undefined),
  disposeAllSessionMcpRuntimes: vi.fn<() => Promise<void>>(async () => undefined),
  triggerInternalHook: vi.fn<TriggerInternalHookMock>(async (_eventValue) => undefined),
  disposeAllBundleLspRuntimes: vi.fn<() => Promise<void>>(async () => undefined),
  drainRetainedEmbeddingProviders: vi.fn<() => Promise<void>>(async () => undefined),
  stopGmailWatcher: vi.fn(async () => undefined),
  disposeAcpSessionManager: vi.fn(async (_reason: string) => undefined),
  fenceSessionSuspensionWritesForGatewayShutdown: vi.fn(),
  closePluginStateDatabaseAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;
const AGENT_HARNESS_CLOSE_GRACE_MS = 5_000;

vi.mock("../channels/plugins/index.js", async () => ({
  ...(await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  )),
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: mocks.stopGmailWatcher,
}));

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook: mocks.triggerInternalHook,
  };
});

vi.mock("../agents/harness/registry.js", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeAgentHarnesses,
}));

vi.mock("../agents/code-mode-state.js", () => ({
  disposeAllCodeModeRuns: mocks.disposeAllCodeModeRuns,
}));

vi.mock("../agents/provider-transport-dispatcher-pool.js", () => ({
  closeProviderTransportDispatcherPool: mocks.closeProviderTransportDispatcherPool,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-mcp-tools.js")>(
    "../agents/agent-bundle-mcp-tools.js",
  )),
  disposeAllSessionMcpRuntimes: mocks.disposeAllSessionMcpRuntimes,
}));

vi.mock("../agents/agent-bundle-lsp-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-lsp-runtime.js")>(
    "../agents/agent-bundle-lsp-runtime.js",
  )),
  disposeAllBundleLspRuntimes: mocks.disposeAllBundleLspRuntimes,
}));

vi.mock("./embeddings-provider-lifetime.js", () => ({
  drainRetainedOpenAiEmbeddingProviders: mocks.drainRetainedEmbeddingProviders,
}));

vi.mock("../agents/session-suspension.js", () => ({
  fenceSessionSuspensionWritesForGatewayShutdown:
    mocks.fenceSessionSuspensionWritesForGatewayShutdown,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  disposeAcpSessionManager: mocks.disposeAcpSessionManager,
}));

vi.mock("../plugin-state/plugin-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../plugin-state/plugin-state-store.js")>(
    "../plugin-state/plugin-state-store.js",
  )),
  closePluginStateDatabaseAsync: mocks.closePluginStateDatabaseAsync,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
  })),
}));

const closeGateway = createGatewayCloseTestHandlerFactory(await import("./server-close.js"));
const { createChatRunState, isChatAbortMarkerCurrent } = await import("./server-chat-state.js");
const { finishGatewayRestartTrace, formatGatewayPendingCloseSteps, startGatewayRestartTrace } =
  await import("./restart-trace.js");
type GatewayCloseClient = GatewayCloseParams["clients"] extends Set<infer T> ? T : never;
type MarkMainSessionsAbortedForRestart = NonNullable<
  GatewayCloseParams["markMainSessionsAbortedForRestart"]
>;
type DrainActiveSessionsForShutdown = NonNullable<
  GatewayCloseParams["drainActiveSessionsForShutdown"]
>;
const originalRestartTraceEnv = process.env.OPENCLAW_GATEWAY_RESTART_TRACE;

function firstMockCall<T extends readonly unknown[]>(mock: { mock: { calls: readonly T[] } }) {
  return mock.mock.calls[0];
}

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory(mocks);

function createGatewayCloseHandler(overrides: Partial<GatewayCloseParams> = {}) {
  return closeGateway(createGatewayCloseTestDeps(overrides));
}

type AbortEntry =
  GatewayCloseParams["chatAbortControllers"] extends Map<string, infer T> ? T : never;

function createAbortEntry(
  entry: Pick<AbortEntry, "sessionId" | "sessionKey"> & Partial<AbortEntry>,
): AbortEntry {
  return {
    controller: new AbortController(),
    startedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    ...entry,
  };
}

function createAbortEntries(
  entries: Record<string, Pick<AbortEntry, "sessionId" | "sessionKey"> & Partial<AbortEntry>>,
) {
  return new Map(Object.entries(entries).map(([id, entry]) => [id, createAbortEntry(entry)]));
}

function createHttpServer(
  close = vi.fn((callback: (error?: Error | null) => void) => callback(null)),
) {
  return { close, closeIdleConnections: vi.fn() };
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    vi.useRealTimers();
    mocks.logInfo.mockClear();
    mocks.logWarn.mockClear();
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.disposeAllCodeModeRuns.mockReset();
    mocks.fenceSessionSuspensionWritesForGatewayShutdown.mockReset();
    for (const mock of [
      mocks.disposeAgentHarnesses,
      mocks.disposeAllSessionMcpRuntimes,
      mocks.triggerInternalHook,
      mocks.disposeAllBundleLspRuntimes,
      mocks.drainRetainedEmbeddingProviders,
      mocks.stopGmailWatcher,
      mocks.closeProviderTransportDispatcherPool,
      mocks.disposeAcpSessionManager,
      mocks.closePluginStateDatabaseAsync,
    ]) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
  });

  afterEach(() => {
    finishGatewayRestartTrace("test.finish");
    resetPluginRuntimeStateForTest();
    memorySessionActorOwners.reset();
    vi.useRealTimers();
    if (originalRestartTraceEnv === undefined) {
      delete process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
    } else {
      process.env.OPENCLAW_GATEWAY_RESTART_TRACE = originalRestartTraceEnv;
    }
  });

  it("retires incognito memory only after the final Gateway drains accepted cleanup", async () => {
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: "/synthetic/gateway-close/incognito-openclaw-agent.sqlite",
    });
    const sessionKey = "agent:main:dashboard:incognito-close";
    const authority = { assertCurrent() {}, authorize() {} };
    const actor = await owner.acquire(
      { sessionKey, database: owner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    const created = await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: "private-session", updatedAt: 1, incognito: true } },
      },
      authority,
    );
    expect(created.kind).toBe("committed");
    const draining = createDeferredCore();
    const release = createDeferredCore();
    let finalClose: Promise<void> | undefined;
    try {
      await createGatewayCloseHandler({
        pluginMetadata: {
          beginClose() {},
          async close(_onFinal, retireRegistry) {
            return (await retireRegistry?.()) ?? { cleanupCount: 0, failures: [] };
          },
        },
      })();
      expect(actor.snapshot(authority)?.entry?.sessionId).toBe("private-session");
      finalClose = createGatewayCloseHandler({
        async stopScheduler() {
          draining.resolve();
          await release.promise;
        },
      })();
      await draining.promise;
      expect(actor.snapshot(authority)?.entry?.sessionId).toBe("private-session");
      release.resolve();
      await finalClose;
      expect(memorySessionActorOwners.read(owner)).toBeUndefined();
      expect(() => actor.snapshot(authority)).toThrow("closed");
      expect(
        memorySessionActorOwners.get(owner).readSession(sessionKey, authority),
      ).toBeUndefined();
    } finally {
      release.resolve();
      await finalClose;
      await actor.release();
    }
  });

  it.each([
    { ownership: "owned", retained: false },
    { ownership: "unowned", retained: false },
    { ownership: "owned", retained: true },
    { ownership: "unowned", retained: true },
  ] as const)(
    "reports $ownership queued cleanup failure and honors retained resources ($retained)",
    async ({ ownership, retained }) => {
      const resolveGatewayContext = () => undefined;
      const cleanupError = new Error("queued engine disposal failed");
      const failure = retained ? new PluginRuntimeCloseRetainedError(cleanupError) : cleanupError;
      const onRemoved = vi.fn(async () => {
        throw failure;
      });
      enqueueSwarmRun({
        groupId: `failed-queued-cleanup-${ownership}`,
        runId: `failed-queued-${ownership}`,
        maxConcurrent: 1,
        activeRunIds: [`failed-queued-blocker-${ownership}`],
        lifecycleOwner: ownership === "owned" ? resolveGatewayContext : undefined,
        start: async () => {},
        onStartFailure: () => true,
        onRemoved,
      });
      const retireRegistry = vi.fn(async () => ({ cleanupCount: 0, failures: [] }));
      const closeSdkResources = vi.fn(async () => {});
      const clearSecretsRuntimeSnapshot = vi.fn();
      const close = createGatewayCloseHandler({
        resolveGatewayContext,
        closeSdkResources,
        clearSecretsRuntimeSnapshot,
        closePluginRegistry: async (onRetirement) => {
          await onRetirement?.(retireRegistry);
          return { memoryErrors: [], pluginFailures: [] };
        },
      });
      try {
        await expect(close()).rejects.toMatchObject({ errors: [failure] });
        expect(onRemoved).toHaveBeenCalledExactlyOnceWith("shutdown");
        expect(closeSdkResources).toHaveBeenCalledTimes(ownership === "owned" && retained ? 0 : 1);
        expect(retireRegistry).toHaveBeenCalledTimes(retained ? 0 : 1);
        expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledTimes(retained ? 0 : 1);
      } finally {
        releaseSwarmRun(`failed-queued-blocker-${ownership}`);
        const { testing } =
          await import("../agents/subagents/swarm/swarm-scheduler.test-support.js");
        testing.reset();
      }
    },
  );

  it.each(["shutdown", "pre-restart", "harness", "sdk"] as const)(
    "retains shared SQLite through actual %s cleanup after grace",
    async (owner) => {
      const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
      const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
      const { closePluginStateDatabaseAsync } = await vi.importActual<
        typeof import("../plugin-state/plugin-state-store.js")
      >("../plugin-state/plugin-state-store.js");
      const hooks = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
        "../hooks/internal-hooks.js",
      );
      const state = await createOpenClawTestState({ label: "shutdown-actual-sqlite" });
      const database = openOpenClawStateDatabase({ env: state.env });
      const sdkDatabase = new DatabaseSync(":memory:");
      const preparedDatabase = new DatabaseSync(":memory:");
      const unregisterPrepared = registerPreparedModelRuntimeClose(async () => {
        preparedDatabase.close();
        unregisterPrepared();
      });
      const sdkHost = new LegacyPluginSdkResourceHost();
      const inspection = new PluginRegistryInspectionResources(async () => {});
      inspection.attach(createEmptyPluginRegistry());
      const sdkDisposalReads: unknown[] = [];
      inspection.register("sdk-provider", {
        id: "native-sdk-borrow",
        dispose: () => {
          sdkDisposalReads.push(database.db.prepare("SELECT 42 AS value").get());
          sdkDatabase.close();
        },
      });
      sdkHost.adopt(inspection, inspection.retain());
      await inspection.release();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const finished = createDeferredCore();
      const reads: unknown[] = [];
      const failures: unknown[] = [];
      const cleanup = vi.fn(async () => {
        entered.resolve();
        try {
          await release.promise;
          reads.push(database.db.prepare("SELECT 1 AS value").get());
          expect(sdkDatabase.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
          expect(preparedDatabase.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
        } catch (error) {
          failures.push(error);
        } finally {
          finished.resolve();
        }
      });
      const eventKey = `gateway:${owner === "pre-restart" ? "pre-restart" : "shutdown"}`;
      if (owner === "sdk") {
        await expect(
          sdkHost.track(async () => {
            void trackAsyncWork(cleanup);
            return "public SDK result";
          }),
        ).resolves.toBe("public SDK result");
      } else if (owner === "harness") {
        const harnesses = await vi.importActual<typeof import("../agents/harness/registry.js")>(
          "../agents/harness/registry.js",
        );
        setActivePluginRegistry(createEmptyPluginRegistry());
        harnesses.registerAgentHarness({
          id: "cleanup-sqlite-fixture",
          label: "Cleanup SQLite fixture",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("The cleanup fixture does not run attempts");
          },
          dispose: cleanup,
        });
        mocks.disposeAgentHarnesses.mockImplementation(harnesses.disposeRegisteredAgentHarnesses);
      } else {
        hooks.registerInternalHook(eventKey, cleanup);
        mocks.triggerInternalHook.mockImplementation(hooks.triggerInternalHook);
      }
      mocks.closePluginStateDatabaseAsync.mockImplementation(async () =>
        closePluginStateDatabaseAsync(),
      );
      const httpClose = vi.fn((callback: (error?: Error | null) => void) => callback(null));
      const close = createGatewayCloseHandler({
        httpServer: createHttpServer(httpClose) as never,
        closeSdkResources: () => sdkHost.close(),
        drainSdkWork: () => sdkHost.drainWork(),
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let closed = false;
      const closing = close({
        reason: "actual cleanup proof",
        ...(owner === "pre-restart" ? { restartExpectedMs: 1000 } : {}),
      }).then((result) => {
        closed = true;
        return result;
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(
          owner === "pre-restart"
            ? GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS
            : owner === "harness"
              ? AGENT_HARNESS_CLOSE_GRACE_MS
              : GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS,
        );
        await vi.waitFor(() => expect(httpClose).toHaveBeenCalledOnce());
        expect(database.db.isOpen).toBe(true);
        expect(sdkDatabase.isOpen).toBe(true);
        expect(preparedDatabase.isOpen).toBe(true);
        expect(sdkDisposalReads).toEqual([]);
        expect(closed).toBe(false);
        expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
        if (owner === "shutdown" || owner === "pre-restart") {
          expect(formatGatewayPendingCloseSteps()).toContain(
            `restart.close.gateway-${owner}-hook=`,
          );
          expect(formatGatewayPendingCloseSteps()).not.toContain(`gateway-${owner}-hook-grace=`);
        }
      } finally {
        release.resolve();
        await finished.promise;
        try {
          const result = await closing;
          expect(result.warnings).toEqual(
            owner === "sdk" ? [] : [owner === "harness" ? "agent-harnesses" : `gateway:${owner}`],
          );
          expect(sdkDisposalReads).toEqual([{ value: 42 }]);
          expect(sdkDatabase.isOpen).toBe(false);
          expect(preparedDatabase.isOpen).toBe(false);
        } finally {
          await sdkHost.close().catch(() => undefined);
          if (sdkDatabase.isOpen) {
            sdkDatabase.close();
          }
          unregisterPrepared();
          if (preparedDatabase.isOpen) {
            preparedDatabase.close();
          }
          hooks.unregisterInternalHook(eventKey, cleanup);
          vi.useRealTimers();
          await closePluginStateDatabaseAsync();
          await state.cleanup();
        }
      }
      expect(formatGatewayPendingCloseSteps()).toBe("none");
      expect(cleanup).toHaveBeenCalledOnce();
      expect(failures).toEqual([]);
      expect(reads).toEqual([{ value: 1 }]);
      expect(database.db.isOpen).toBe(false);
      expect(mocks.closePluginStateDatabaseAsync).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "finishes shared state cleanup after actual SDK disposal rejects (global failure: %s)",
    async (globalFailure) => {
      const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
      const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
      const { closePluginStateDatabaseAsync } = await vi.importActual<
        typeof import("../plugin-state/plugin-state-store.js")
      >("../plugin-state/plugin-state-store.js");
      const state = await createOpenClawTestState({ label: "sdk-disposal-failure-tail" });
      const database = openOpenClawStateDatabase({ env: state.env });
      const sdkDatabase = new DatabaseSync(":memory:");
      const sdkHost = new LegacyPluginSdkResourceHost();
      const inspection = new PluginRegistryInspectionResources(async () => {});
      inspection.attach(createEmptyPluginRegistry());
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const disposalError = new Error("synthetic SDK disposal failure");
      const dispose = vi.fn(async () => {
        entered.resolve();
        await resume.promise;
        expect(database.db.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
        sdkDatabase.close();
        throw disposalError;
      });
      inspection.register("sdk-provider", { id: "native-sdk-failure", dispose });
      sdkHost.adopt(inspection, inspection.retain());
      await inspection.release();
      const globalError = new Error("synthetic singleton reset failure");
      let resetFailureEnabled = globalFailure;
      const reset = vi.fn(() => {
        if (resetFailureEnabled) {
          throw globalError;
        }
      });
      resolveGlobalSingleton(Symbol("sdk-failure-tail"), () => ({}), reset);
      const clearSecretsRuntimeSnapshot = vi.fn();
      mocks.closePluginStateDatabaseAsync.mockImplementation(async () =>
        closePluginStateDatabaseAsync(),
      );
      let sdkFailure: unknown;
      const close = createGatewayCloseHandler({
        clearSecretsRuntimeSnapshot,
        closeSdkResources: () =>
          sdkHost.close().catch((error: unknown) => {
            sdkFailure = error;
            throw error;
          }),
      });
      const outcome = close({ reason: "SDK failure tail proof" }).catch((error: unknown) => error);
      const expectCleanupFailure = (failure: unknown) => {
        assert(failure instanceof AggregateError);
        if (globalFailure) {
          expect(failure.cause).toBe(sdkFailure);
          expect(failure.errors).toEqual([
            sdkFailure,
            expect.objectContaining({ errors: [globalError] }),
          ]);
        } else {
          expect(failure).toBe(sdkFailure);
        }
      };
      try {
        await entered.promise;
        expect(database.db.isOpen).toBe(true);
        expect(sdkDatabase.isOpen).toBe(true);
        expect(reset).not.toHaveBeenCalled();
        expect(clearSecretsRuntimeSnapshot).not.toHaveBeenCalled();
        resume.resolve();
        const failure = await outcome;
        expectCleanupFailure(failure);
        expect(sdkDatabase.isOpen).toBe(false);
        expect(database.db.isOpen).toBe(false);
        expect(reset).toHaveBeenCalledOnce();
        expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledOnce();
        expectCleanupFailure(
          await close({ reason: "retry SDK failure tail proof" }).catch((error: unknown) => error),
        );
        expect(dispose).toHaveBeenCalledOnce();
        expect(reset).toHaveBeenCalledTimes(2);
        expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledTimes(2);
      } finally {
        resetFailureEnabled = false;
        resume.resolve();
        await outcome;
        await sdkHost.close().catch(() => undefined);
        if (sdkDatabase.isOpen) {
          sdkDatabase.close();
        }
        await closePluginStateDatabaseAsync();
        await state.cleanup();
      }
    },
  );

  it("still runs later teardown when cron.stopAndDrain() rejects (no listener strand)", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const stopAndDrain = vi.fn().mockRejectedValue(new Error("stream watcher stop failed"));
    const stopCronMaintenance = vi.fn(async () => {});
    const httpClose = vi.fn((cb: (err?: Error | null) => void) => cb(null));
    const deps = createGatewayCloseTestDeps({
      cron: { stop: vi.fn(), stopAndDrain } as never,
      stopCronMaintenance,
      httpServer: createHttpServer(httpClose) as never,
    });
    const close = closeGateway(deps);

    const result = await close({ reason: "test" });

    expect(stopAndDrain).toHaveBeenCalledTimes(1);
    expect(stopCronMaintenance).toHaveBeenCalledOnce();
    expect(stopCronMaintenance.mock.invocationCallOrder[0]).toBeLessThan(
      httpClose.mock.invocationCallOrder[0]!,
    );
    expect(deps.heartbeatRunner.stop).toHaveBeenCalledTimes(1);
    expect(httpClose).toHaveBeenCalled();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(getActivePluginRegistry()).toBeNull();
  });

  it.each(["callback", "admission"] as const)(
    "distinguishes trusted diagnostic %s failures during Gateway shutdown",
    async (failureKind) => {
      const failure = new Error("synthetic plugin cleanup failed");
      const stop = vi.fn(async () => {
        throw failure;
      });
      const instance = new PluginInstance("diagnostics-otel");
      const service = instance.wrap<OpenClawPluginService>({
        id: "diagnostics-otel",
        start: async () => {},
        stop,
      });
      const registry = createEmptyPluginRegistry();
      registry.services.push(
        createServiceRegistration(service, { pluginId: "diagnostics-otel", origin: "bundled" }),
      );
      setActivePluginRegistry(registry);
      const pluginServices = await startPluginServices({ registry, config: {} });
      if (failureKind === "admission") {
        await instance.dispose();
      }
      const clearSecretsRuntimeSnapshot = vi.fn();
      const deps = createGatewayCloseTestDeps({ pluginServices, clearSecretsRuntimeSnapshot });
      try {
        const closing = closeGateway(deps)({ reason: "gateway startup failed" });
        if (failureKind === "admission") {
          await expect(closing).rejects.toThrow(/retir/);
          expect(stop).not.toHaveBeenCalled();
          expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
          expect(getActivePluginRegistry()).toBe(registry);
          expect(clearSecretsRuntimeSnapshot).not.toHaveBeenCalled();
        } else {
          const result = await closing;
          expect(result.warnings).toContain("plugin-services");
          expect(stop).toHaveBeenCalledOnce();
          expect(mocks.closePluginStateDatabaseAsync).toHaveBeenCalledOnce();
          expect(getActivePluginRegistry()).toBeNull();
          expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledOnce();
          expect(await pluginServices.stop()).toEqual({ errors: [failure] });
          expect(stop).toHaveBeenCalledOnce();
        }
        expect(deps.heartbeatRunner.stop).toHaveBeenCalledOnce();
      } finally {
        await pluginServices.stop().catch(() => {});
        await instance.dispose();
      }
    },
  );

  it.each(["subsystem failures", "explicit channels"] as const)(
    "completes %s teardown and clears registry and lifecycle state",
    async (scenario) => {
      const fails = scenario === "subsystem failures";
      const explicit = scenario === "explicit channels";
      const lifecycleSlot = resolveGlobalMap<string, number>(
        Symbol.for("openclaw.test.gatewayCloseLifecycleSlot"),
        (state) => state.clear(),
      );
      lifecycleSlot.set("stale", 1);
      setActivePluginRegistry(createEmptyPluginRegistry());
      mocks.listChannelPlugins.mockReturnValue(
        fails ? [{ id: "telegram" }, { id: "discord" }] : [],
      );
      const lifecycleUnsub = vi.fn();
      const stopChannel = vi.fn(async (id: string) => {
        if (fails && id === "telegram") {
          throw new Error("telegram stuck");
        }
      });
      const deps = createGatewayCloseTestDeps({
        lifecycleUnsub,
        stopChannel,
        ...(explicit ? { channelIds: ["telegram", "discord"] } : {}),
        ...(fails
          ? {
              bonjourStop: async () => {
                throw new Error("mdns unavailable");
              },
            }
          : {}),
      });
      const result = await closeGateway(deps)({ reason: "test shutdown" });
      expect(result.warnings).toStrictEqual(fails ? ["bonjour", "channel/telegram"] : []);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      for (const stop of [
        deps.cron.stop,
        deps.heartbeatRunner.stop,
        deps.stopMediaCleanup,
        deps.chatRunState.clear,
        lifecycleUnsub,
      ]) {
        expect(stop).toHaveBeenCalledOnce();
      }
      expect(stopChannel.mock.calls.map(([id]) => id)).toEqual(["telegram", "discord"]);
      if (explicit) {
        expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
      }
      expect(lifecycleSlot.size).toBe(0);
      expect(getActivePluginRegistry()).toBeNull();
    },
  );

  it.each(["media", "stopPeriodicTasks", "skillUsageCleanup", "updateCheck"] as const)(
    "waits for in-flight %s cleanup before shared state closes",
    async (owner) => {
      vi.useFakeTimers();
      const stopped = createDeferredCore();
      const deps = createGatewayCloseTestDeps();
      const entered = createDeferredCore();
      const stop = async () => {
        entered.resolve();
        await stopped.promise;
      };
      if (owner === "media") {
        deps.stopMediaCleanup = async () => {
          await stop();
          return "drained";
        };
      } else if (owner === "updateCheck") {
        deps.updateCheckStop = stop;
      } else {
        deps.maintenance![owner] = stop;
      }
      const close = closeGateway(deps);
      let closed = false;
      const closing = close({ reason: "test" }).then(() => {
        closed = true;
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
        expect(closed).toBe(false);
        if (owner === "updateCheck") {
          expect(mocks.disposeAllCodeModeRuns).not.toHaveBeenCalled();
        }
      } finally {
        stopped.resolve();
        await closing;
      }
      expect(mocks.closePluginStateDatabaseAsync).toHaveBeenCalledOnce();
      expect(closed).toBe(true);
      if (owner === "updateCheck") {
        expect(mocks.disposeAllCodeModeRuns).toHaveBeenCalledOnce();
      }
    },
  );

  it("retains shared state when media cleanup times out", async () => {
    const { registerMediaCleanupDrain } = await import("./server-media-cleanup-lifecycle.js");
    const cleanup = createDeferredCore();
    registerMediaCleanupDrain(cleanup.promise);
    const stopMediaCleanup = vi.fn(async () => "timed-out" as const);
    const close = createGatewayCloseHandler({ stopMediaCleanup });
    const closing = close({ reason: "test" });
    try {
      await vi.waitFor(() => expect(stopMediaCleanup).toHaveBeenCalledTimes(1));
      expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await closing;
    }
    const result = await closing;
    expect(mocks.closePluginStateDatabaseAsync).toHaveBeenCalledOnce();
    expect(result.warnings).toContain("media-cleanup");
  });

  it.skipIf(process.platform === "win32").each([
    { restart: false, ignoreTerm: false },
    { restart: true, ignoreTerm: true },
  ])(
    "terminates supervised process trees before Gateway close returns (restart=$restart, ignores TERM=$ignoreTerm)",
    async ({ restart, ignoreTerm }) => {
      const previousServiceMarker = process.env.OPENCLAW_SERVICE_MARKER;
      process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      const supervisor = getProcessSupervisor();
      let output = "";
      let run: ManagedRun | undefined;
      let replacementRun: ManagedRun | undefined;
      let rootPid: number | undefined;
      let descendantPid: number | undefined;

      try {
        // Readiness follows TERM handler installation and closure of inherited descriptors.
        const descendantScript = `
          ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
          setInterval(() => {}, 1_000);
          process.send("ready", () => process.disconnect());
        `;
        run = await supervisor.spawn({
          mode: "child",
          argv: [
            process.execPath,
            "-e",
            `
              const { spawn } = require("node:child_process");
              const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
                stdio: ["ignore", "ignore", "ignore", "ipc"],
              });
              child.once("message", () => {
                child.once("disconnect", () => {
                  process.stdout.write(process.pid + " " + child.pid + "\\n");
                });
              });
            `,
          ],
          stdinMode: "pipe-closed",
          onStdout: (chunk) => {
            output += chunk;
          },
        });
        await vi.waitFor(() => expect(output).toMatch(/^\d+ \d+/u));
        const match = /^(\d+) (\d+)/u.exec(output);
        rootPid = Number(match?.[1]);
        descendantPid = Number(match?.[2]);
        expect(isProcessAlive(rootPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        const close = createGatewayCloseHandler();
        await close({
          reason: restart ? "gateway restarting" : "gateway stopping",
          ...(restart ? { restartExpectedMs: 1500, drainTimeoutMs: 0 } : {}),
        });

        // Do not poll after close: returning while either process lives is the regression.
        expect(isProcessAlive(rootPid)).toBe(false);
        expect(isProcessAlive(descendantPid)).toBe(false);
        await expect(run.waitForExtinction!()).resolves.toBeUndefined();
        const nextSupervisor = getProcessSupervisor();
        expect(nextSupervisor).not.toBe(supervisor);
        replacementRun = await nextSupervisor.spawn({
          mode: "child",
          argv: [process.execPath, "-e", ""],
          exactEnv: true,
          stdinMode: "pipe-closed",
        });
        await expect(replacementRun.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
      } finally {
        try {
          run?.cancel();
          replacementRun?.cancel();
          killPidIfAlive(rootPid);
          killPidIfAlive(descendantPid);
          await run?.waitForExtinction?.().catch(() => undefined);
          await replacementRun?.wait().catch(() => undefined);
        } finally {
          if (previousServiceMarker === undefined) {
            delete process.env.OPENCLAW_SERVICE_MARKER;
          } else {
            process.env.OPENCLAW_SERVICE_MARKER = previousServiceMarker;
          }
        }
      }
    },
  );

  it("replaces the process supervisor after a concurrent adapter startup failure", async () => {
    const { promise: embeddingDrainStarted, resolve: markEmbeddingDrainStarted } =
      createDeferredCore();
    const { promise: embeddingDrainReleased, resolve: releaseEmbeddingDrain } =
      createDeferredCore();
    const supervisor = getProcessSupervisor();
    const close = createGatewayCloseHandler({
      drainRetainedOpenAiEmbeddingProviders: async () => {
        markEmbeddingDrainStarted();
        await embeddingDrainReleased;
      },
    });
    const closing = close({ reason: "test" });
    await embeddingDrainStarted;

    const failedStart = supervisor.spawn({
      mode: "child",
      argv: [`/openclaw-missing-adapter-${process.pid}`],
      exactEnv: true,
      stdinMode: "pipe-closed",
    });
    releaseEmbeddingDrain();

    const started = await failedStart;
    await started.wait();
    await closing;
    const nextSupervisor = getProcessSupervisor();
    const run = await nextSupervisor.spawn({
      mode: "child",
      argv: [process.execPath, "-e", ""],
      exactEnv: true,
      stdinMode: "pipe-closed",
    });
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    expect(nextSupervisor).not.toBe(supervisor);
  });

  it("reports and joins an in-flight config reload before teardown", async () => {
    process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
    startGatewayRestartTrace("stop.signal.received");
    const events: string[] = [];
    mocks.fenceSessionSuspensionWritesForGatewayShutdown.mockImplementation(() => {
      events.push("session-suspension-timers");
      return 1;
    });
    const { promise: reloadStopped, resolve: releaseReload } = createDeferredCore();
    const configReloader = {
      stop: vi.fn(async () => {
        events.push("reload:stopping");
        await reloadStopped;
        events.push("reload:stopped");
      }),
    };
    const pluginServices = {
      stop: vi.fn(async () => {
        events.push("plugins:stopped");
      }),
    };
    const stopChannel = vi.fn(async () => {
      events.push("channel:stopped");
    });
    const close = createGatewayCloseHandler({
      channelIds: ["discord"],
      configReloader,
      pluginServices: pluginServices as never,
      stopChannel,
    });

    const closePromise = close({ reason: "test" });
    await vi.waitFor(() => {
      expect(mocks.fenceSessionSuspensionWritesForGatewayShutdown).toHaveBeenCalledOnce();
      expect(events).toEqual(["session-suspension-timers", "reload:stopping"]);
    });
    try {
      expect(pluginServices.stop).not.toHaveBeenCalled();
      expect(stopChannel).not.toHaveBeenCalled();
      const messages = mocks.logInfo.mock.calls.map(([message]) => String(message));
      expect(messages.some((line) => line.includes("restart.close.config-reloader.begin "))).toBe(
        true,
      );
      expect(messages.some((line) => line.includes("restart.close.config-reloader "))).toBe(false);
      expect(messages.some((line) => line.includes("restart.close.channels"))).toBe(false);
    } finally {
      releaseReload();
      await closePromise;
    }
    const completedMessages = mocks.logInfo.mock.calls.map(([message]) => String(message));
    for (const phase of ["config-reloader", "channels"]) {
      expect(completedMessages.some((line) => line.includes(`restart.close.${phase}.begin `))).toBe(
        true,
      );
      expect(completedMessages.some((line) => line.includes(`restart.close.${phase} `))).toBe(true);
    }

    expect(events).toEqual([
      "session-suspension-timers",
      "reload:stopping",
      "reload:stopped",
      "plugins:stopped",
      "channel:stopped",
    ]);
  });

  it("settles pending ACP disposal before plugin services and channel runtimes", async () => {
    const disposal = createDeferredCore();
    const events: string[] = [];
    mocks.disposeAcpSessionManager.mockImplementation(async () => {
      events.push("acp-sessions");
      await disposal.promise;
    });
    const pluginServices = {
      stop: vi.fn(async () => {
        events.push("plugin-services");
      }),
    };
    const stopChannel = vi.fn(async (channelId: string) => {
      events.push(`channel:${channelId}`);
    });
    const close = createGatewayCloseHandler({
      channelIds: ["discord"],
      pluginServices: pluginServices as never,
      stopChannel,
    });
    vi.useFakeTimers();
    const closing = close({ reason: "test" });
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      expect(mocks.disposeAcpSessionManager).toHaveBeenCalledOnce();
      expect(pluginServices.stop).not.toHaveBeenCalled();
    } finally {
      disposal.resolve();
      await closing;
    }
    expect(events).toEqual(["acp-sessions", "plugin-services", "channel:discord"]);
    expect(mocks.disposeAcpSessionManager).toHaveBeenCalledWith("gateway-shutdown");
  });

  it("clears secrets only after a failed channel teardown (#112681)", async () => {
    const events: string[] = [];
    const clearSecretsRuntimeSnapshot = vi.fn(() => {
      events.push("clear-secrets");
    });
    const close = createGatewayCloseHandler({
      channelIds: ["telegram"],
      stopChannel: async (channelId) => {
        events.push(`channel:${channelId}`);
        throw new Error("stop failed");
      },
      clearSecretsRuntimeSnapshot,
    });
    const result = await close({ reason: "test" });
    expect(events).toEqual(["channel:telegram", "clear-secrets"]);
    expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledOnce();
    expect(result.warnings).toContain("channel/telegram");
  });

  it("cleans up live runtime children while plugin service cleanup is stalled", async () => {
    vi.useFakeTimers();
    const children = [
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
    ];
    const exits = children.map((child) => once(child, "exit"));
    const spawnEvents = children.map((child) => once(child, "spawn"));
    mocks.disposeAllSessionMcpRuntimes.mockImplementation(async () => {
      children[0]?.kill("SIGTERM");
      await exits[0];
    });
    mocks.disposeAllBundleLspRuntimes.mockImplementation(async () => {
      children[1]?.kill("SIGTERM");
      await exits[1];
    });
    const pluginCleanup = createDeferredCore();
    const pluginServices = {
      reload: vi.fn(async () => {}),
      stop: vi.fn(() => pluginCleanup.promise),
    };
    const stopChannel = vi.fn(async () => undefined);
    const deps = createGatewayCloseTestDeps({
      channelIds: ["discord"],
      pluginServices,
      stopChannel,
    });

    let closePromise: ReturnType<ReturnType<typeof createGatewayCloseHandler>> | undefined;
    let closed = false;
    try {
      await Promise.all(spawnEvents);
      const close = closeGateway(deps);
      closePromise = close({ reason: "SIGINT" }).then((result) => {
        closed = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS);

      expect(pluginServices.stop).toHaveBeenCalledOnce();
      expect(mocks.disposeAllSessionMcpRuntimes).toHaveBeenCalledOnce();

      expect(mocks.disposeAllBundleLspRuntimes).toHaveBeenCalledOnce();
      await expect(Promise.all(exits)).resolves.toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopChannel).toHaveBeenCalledWith("discord");
      expect(deps.heartbeatRunner.stop).toHaveBeenCalledOnce();
      expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
      expect(closed).toBe(false);

      pluginCleanup.resolve();
      const result = await closePromise;
      expect(result.warnings).toContain("plugin-services");
      expect(pluginServices.stop).toHaveBeenCalledOnce();
      expect(mocks.closePluginStateDatabaseAsync).toHaveBeenCalledOnce();
    } finally {
      pluginCleanup.resolve();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }
      await Promise.allSettled([...exits, closePromise]);
    }
  });

  it("retains shared state after final plugin grace while cleanup stalls", async () => {
    vi.useFakeTimers();
    const cleanup = createDeferredCore();
    const stop = vi.fn(() => cleanup.promise);
    const registry = createEmptyPluginRegistry();
    registry.services.push(
      createServiceRegistration(
        { id: "pending-cleanup", start() {}, stop },
        { pluginId: "shutdown-test" },
      ),
    );
    setActivePluginRegistry(registry);
    const pluginServices = await startPluginServices({ registry, config: {} });
    const strictStopping = pluginServices.stop({
      strict: true,
      deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
    });
    const strictFailure = strictStopping.catch((error: unknown) => error);
    let closing: ReturnType<ReturnType<typeof createGatewayCloseHandler>> | undefined;

    try {
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(await strictFailure).toMatchObject({
        errors: [expect.objectContaining({ message: expect.stringContaining("timed out") })],
      });
      expect(stop).toHaveBeenCalledOnce();

      const clearSecretsRuntimeSnapshot = vi.fn();
      const deps = createGatewayCloseTestDeps({
        channelIds: ["discord"],
        pluginServices,
        clearSecretsRuntimeSnapshot,
      });
      const close = closeGateway(deps);
      let closed = false;
      closing = close({ reason: "gateway restarting", restartExpectedMs: 1_500 }).then((result) => {
        closed = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(closed).toBe(false);
      expect(deps.stopChannel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deps.stopChannel).toHaveBeenCalledWith("discord");
      expect(mocks.disposeAllSessionMcpRuntimes).toHaveBeenCalledOnce();
      expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
      expect(clearSecretsRuntimeSnapshot).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(registry);
      expect(closed).toBe(false);
      expect(stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(closed).toBe(true);
      const result = await closing;
      expect(stop).toHaveBeenCalledOnce();
      expect(deps.stopChannel).toHaveBeenCalledWith("discord");
      expect(mocks.closePluginStateDatabaseAsync).toHaveBeenCalledOnce();
      expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledOnce();
      expect(getActivePluginRegistry()).not.toBe(registry);
      expect(result.warnings).toContain("plugin-services");
    } finally {
      cleanup.resolve();
      await Promise.allSettled([strictStopping, closing]);
    }
  });

  it.each([
    ["shutdown", true, ["session-A"], undefined, undefined],
    ["restart", false, ["session-A"], 123, 100],
  ] as const)(
    "drains active sessions after replies for %s (timed out: %s, sessions: %j, restart: %s, budget: %s)",
    async (reason, timedOut, emittedSessionIds, restartExpectedMs, drainTimeoutMs) => {
      const order: string[] = [];
      const drainActiveSessionsForShutdown = vi.fn<DrainActiveSessionsForShutdown>(async () => {
        order.push("session-end");
        return { emittedSessionIds: [...emittedSessionIds], timedOut };
      });
      const close = createGatewayCloseHandler({
        drainActiveSessionsForShutdown,
        getPendingReplyCount: () => {
          order.push("reply-drain");
          return 0;
        },
      });
      const result = await close(
        reason === "restart"
          ? {
              reason: "gateway restarting",
              restartExpectedMs,
              drainTimeoutMs,
            }
          : { reason: "SIGTERM" },
      );
      expect(drainActiveSessionsForShutdown).toHaveBeenCalledOnce();
      expect(firstMockCall(drainActiveSessionsForShutdown)?.[0]?.reason).toBe(reason);
      expect(order).toStrictEqual(
        reason === "restart" ? ["reply-drain", "session-end"] : ["session-end"],
      );
      expect(result.warnings.includes("session-end-drain")).toBe(timedOut);
    },
  );

  it("drains each Gateway's replies independently of another Gateway's pending work", async () => {
    vi.useFakeTimers();
    let firstPending = 1;
    let secondPending = 1;
    const unregister = registerDispatcher(() => secondPending);
    const firstDeps = createGatewayCloseTestDeps({ getPendingReplyCount: () => firstPending });
    const secondDeps = createGatewayCloseTestDeps({ getPendingReplyCount: () => secondPending });
    const options = { restartExpectedMs: 123, drainTimeoutMs: 500 };
    const firstClose = closeGateway(firstDeps)(options);
    const secondClose = closeGateway(secondDeps)(options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(firstDeps.chatRunState.clear).not.toHaveBeenCalled();
      firstPending = 0;
      await vi.advanceTimersByTimeAsync(100);
      expect((await firstClose).warnings).not.toContain("restart-reply-drain");
      expect(secondDeps.chatRunState.clear).not.toHaveBeenCalled();
      secondPending = 0;
      await vi.advanceTimersByTimeAsync(100);
      expect((await secondClose).warnings).not.toContain("restart-reply-drain");
    } finally {
      firstPending = 0;
      secondPending = 0;
      unregister();
      await vi.runAllTimersAsync();
      await Promise.allSettled([firstClose, secondClose]);
    }
  });

  it.each([false, true])(
    "cancels only captured Gateway replies before disposal (marker fails: %s)",
    async (markerFails) => {
      const resolveGatewayContext = () => undefined;
      const otherGatewayContext = () => undefined;
      const operations: ReplyOperation[] = [];
      const begin = (key: string, resolver = resolveGatewayContext) => {
        const operation = createReplyOperation({
          sessionKey: key,
          sessionId: key,
          resetTriggered: false,
        });
        operation.setPhase("running");
        bindGatewayContextResolver(operation, resolver);
        operations.push(operation);
        return operation;
      };
      const owned = begin("agent:main:closing");
      const reboundDuringAbort = begin("agent:main:rebound");
      owned.abortSignal.addEventListener(
        "abort",
        () => bindGatewayContextResolver(reboundDuringAbort, otherGatewayContext),
        { once: true },
      );
      const replaced = begin("agent:main:replaced");
      const other = begin("agent:main:other", otherGatewayContext);
      const finalizing = begin("agent:main:finalizing");
      finalizing.freezeAbort();
      const markerEntered = createDeferredCore();
      const markerCommitted = createDeferredCore();
      const observed: boolean[] = [];
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(
        async () => {
          markerEntered.resolve(undefined);
          await markerCommitted.promise;
          if (markerFails) {
            throw new Error("marker write failed");
          }
        },
      );
      const close = createGatewayCloseHandler({
        getPendingReplyCount: () => Number(!owned.abortSignal.aborted),
        markMainSessionsAbortedForRestart,
        channelIds: ["telegram"],
        stopChannel: async () => {
          observed.push(owned.abortSignal.aborted);
        },
        disposeAllCodeModeRuns: () => {
          observed.push(owned.abortSignal.aborted);
        },
        resolveGatewayContext,
      });
      try {
        const closing = close({ restartExpectedMs: 123, drainTimeoutMs: 0 });
        await markerEntered.promise;
        expect(owned.abortSignal.aborted).toBe(false);
        replaced.complete();
        const replacement = begin(replaced.key);
        markerCommitted.resolve(undefined);
        const result = await closing;

        expect(markMainSessionsAbortedForRestart).toHaveBeenCalledWith(
          expect.objectContaining({ activeRuns: [], reason: "gateway restart shutdown" }),
        );
        expect(observed).toEqual([true, true]);
        expect(isAgentRunRestartAbortReason(owned.abortSignal.reason)).toBe(true);
        expect(other.abortSignal.aborted).toBe(false);
        expect(reboundDuringAbort.abortSignal.aborted).toBe(false);
        expect(replacement.abortSignal.aborted).toBe(false);
        expect(finalizing.abortSignal.aborted).toBe(false);
        expect(finalizing.result).toBeNull();
        expect(result.warnings.includes("restart-main-session-marker")).toBe(markerFails);
      } finally {
        markerCommitted.resolve(undefined);
        for (const operation of operations) {
          operation.complete();
        }
      }
    },
  );

  it("aborts active runs when restart reply drain times out", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const agentController = new AbortController();
    const chatRunState = createChatRunState();
    const run = chatRunState.getOrCreate("run-1");
    run.buffer = "partial reply";
    run.deltaSentAt = Date.now();
    run.assistantScope = {
      itemId: "assistant-1",
      prefix: "",
      boundaryNewlines: 0,
      separatorLength: 0,
    };
    chatRunState.takeBufferDelta("run-1", "par");
    run.agentText = {
      assistant: {
        lastSentAt: Date.now(),
        bufferedEvent: { sessionKey: "session-1", payload: {} as never },
      },
    };
    const chatAbortControllers = createAbortEntries({
      "run-1": {
        controller,
        sessionId: "run-1",
        sessionKey: "session-1",
      },
      "agent-run-1": {
        controller: agentController,
        sessionId: "agent-run-1",
        sessionKey: "session-1",
        kind: "agent" as const,
      },
    });
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const close = createGatewayCloseHandler({
      broadcast,
      nodeSendToSession,
      chatRunState,
      chatAbortControllers,
      removeChatRun: vi.fn(() => ({
        sessionKey: "session-1",
        clientRunId: "run-1",
        registeredAtMs: 1_000,
        registeredSequence: 1,
      })),
    });

    const closePromise = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await closePromise;

    expect(result.warnings).toContain("restart-reply-drain");
    expect(controller.signal.aborted).toBe(true);
    expect(agentController.signal.aborted).toBe(true);
    expect(chatAbortControllers.has("run-1")).toBe(false);
    expect(chatAbortControllers.has("agent-run-1")).toBe(false);
    expect(chatRunState.runs.has("run-1")).toBe(false);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes(
          "restart reply drain timed out after 100ms with chatRuns=2 still active",
        ),
      ),
    ).toBe(true);
    for (const runId of ["run-1", "agent-run-1"]) {
      const payload = expect.objectContaining({ runId, state: "aborted", stopReason: "restart" });
      expect(broadcast).toHaveBeenCalledWith("chat", payload, { sessionKeys: ["session-1"] });
      expect(nodeSendToSession).toHaveBeenCalledWith("session-1", "chat", payload);
    }
  });

  it("aborts queued turns before restart shutdown continues", async () => {
    const controller = new AbortController();
    const chatQueuedTurns = new Map([
      [
        "queued-1",
        {
          controller,
          sessionId: "session-1",
          sessionKey: "session-1",
        },
      ],
    ]);
    const close = createGatewayCloseHandler({
      chatQueuedTurns,
    });

    const result = await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(result.warnings).toContain("restart-reply-drain");
    expect(controller.signal.aborted).toBe(true);
    expect(chatQueuedTurns.size).toBe(0);
  });

  it.each(["shutdown", "finalizing"] as const)(
    "cancels only abortable runs when the %s drain budget is exhausted",
    async (mode) => {
      const controller = new AbortController();
      const finalizing = mode === "finalizing";
      const restart = mode !== "shutdown";
      const runId = finalizing ? "run-finalizing" : "run-1";
      const chatAbortControllers = createAbortEntries({
        [runId]: {
          controller,
          sessionId: runId,
          sessionKey: finalizing ? "session-finalizing" : "session-1",
          ...(finalizing ? { projectSessionActive: false, isAbortable: () => false } : {}),
        },
      });
      const getPendingReplyCount = vi.fn(() => (restart ? 0 : 1));
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
      const deps = createGatewayCloseTestDeps({
        chatAbortControllers,
        getPendingReplyCount,
        ...(restart ? {} : { markMainSessionsAbortedForRestart }),
      });
      const result = await closeGateway(deps)({
        reason: restart ? "gateway restarting" : "SIGTERM",
        ...(restart ? { restartExpectedMs: 123 } : {}),
        drainTimeoutMs: 0,
      });
      expect(result.warnings.includes("restart-reply-drain")).toBe(restart);
      expect(controller.signal.aborted).toBe(!finalizing);
      expect(chatAbortControllers.has(runId)).toBe(finalizing);
      expect(chatAbortControllers.size).toBe(finalizing ? 1 : 0);
      if (!finalizing) {
        expect(isAgentRunRestartAbortReason(controller.signal.reason)).toBe(restart);
      }
      if (!restart) {
        expect(getPendingReplyCount).not.toHaveBeenCalled();
        expect(markMainSessionsAbortedForRestart).not.toHaveBeenCalled();
        expect(deps.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId, state: "aborted", stopReason: "rpc" }),
          { sessionKeys: ["session-1"] },
        );
      }
    },
  );

  it("marks active main sessions for restart recovery before aborting restart-drained runs", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const agentController = new AbortController();
    const completedController = new AbortController();
    const hiddenController = new AbortController();
    const alreadyAbortedController = new AbortController();
    alreadyAbortedController.abort();
    const chatAbortControllers = createAbortEntries({
      "run-1": {
        controller,
        sessionId: "session-id-1",
        sessionKey: "agent:main:main",
        lifecycleGeneration: "generation-1",
      },
      "agent-run-1": {
        controller: agentController,
        sessionId: "session-id-2",
        sessionKey: "agent:main:test:direct:source",
        lifecycleGeneration: "generation-1",
        kind: "agent" as const,
      },
      "completed-run": {
        controller: completedController,
        sessionId: "completed-session-id",
        sessionKey: "agent:main:completed",
        lifecycleGeneration: "generation-1",
        projectSessionActive: false,
        projectSessionTerminalPersisted: true,
        registrationCleanupRequested: true,
      },
      "stale-run": {
        controller: alreadyAbortedController,
        sessionId: "stale-session-id",
        sessionKey: "agent:main:stale",
        lifecycleGeneration: "generation-1",
      },
      "hidden-run": {
        controller: hiddenController,
        sessionId: "hidden-session-id",
        sessionKey: "agent:main:hidden",
        lifecycleGeneration: "generation-1",
        controlUiVisible: false,
        kind: "agent" as const,
      },
    });
    const chatRunState = createTestChatRunState();
    const completedRun = chatRunState.getOrCreate("completed-run");
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(async () => {
      events.push("marker");
    });
    const removeChatRun = vi.fn(() => {
      events.push("abort");
      return {
        sessionKey: "agent:main:main",
        clientRunId: "run-1",
        registeredAtMs: 1_000,
        registeredSequence: 1,
      };
    });
    const close = createGatewayCloseHandler({
      chatAbortControllers,
      chatRunState,
      markMainSessionsAbortedForRestart,
      removeChatRun,
      resolveActiveSessionIdForKey: (sessionKey) => {
        if (sessionKey === "agent:main:main") {
          return "current-session-id-1";
        }
        if (sessionKey === "agent:main:test:direct:source") {
          return "stale-agent-registry-id";
        }
        return undefined;
      },
    });

    const result = await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(result.warnings).toContain("restart-reply-drain");
    expect(markMainSessionsAbortedForRestart).toHaveBeenCalledTimes(1);
    expect(events[0]).toBe("marker");
    const markerCall = firstMockCall(markMainSessionsAbortedForRestart);
    expect(markerCall?.[0]?.reason).toBe("gateway restart shutdown");
    expect(markerCall?.[0]?.activeRuns).toEqual([
      {
        runId: "run-1",
        lifecycleGeneration: "generation-1",
        sessionKey: "agent:main:main",
        sessionId: "current-session-id-1",
        observedAt: expect.any(Number),
      },
      {
        runId: "agent-run-1",
        lifecycleGeneration: "generation-1",
        sessionKey: "agent:main:test:direct:source",
        sessionId: "session-id-2",
        observedAt: expect.any(Number),
      },
    ]);
    expect(controller.signal.aborted).toBe(true);
    expect(agentController.signal.aborted).toBe(true);
    expect(completedController.signal.aborted).toBe(true);
    expect(hiddenController.signal.aborted).toBe(true);
    const completedMarker = completedRun.abortMarker;
    expect(completedMarker).toEqual({
      abortedAtMs: expect.any(Number),
      sequence: expect.any(Number),
    });
    chatRunState.registry.add("completed-run", {
      sessionKey: "agent:main:fresh",
      clientRunId: "completed-run",
    });
    expect(
      isChatAbortMarkerCurrent(completedMarker, chatRunState.registry.peek("completed-run")),
    ).toBe(false);
  });

  it.each(["post-terminal", "untracked", "settled", "pending"] as const)(
    "preserves terminal recovery until persistence and caller work settle (%s)",
    async (persistence) => {
      vi.useFakeTimers();
      const callerPending = persistence === "post-terminal";
      const runId = callerPending ? "post-terminal-run" : "completed-run";
      const sessionId = callerPending ? "post-terminal-session-id" : "completed-session-id";
      const sessionKey = callerPending ? "agent:main:post-terminal" : "agent:main:completed";
      const entry = createAbortEntry({
        sessionId,
        sessionKey,
        lifecycleGeneration: "generation-1",
        projectSessionActive: false,
        projectSessionTerminalPersisted: callerPending,
        ...(callerPending ? {} : { registrationCleanupRequested: true }),
        ...(persistence === "settled" || persistence === "pending"
          ? {
              projectSessionTerminalPersistence:
                persistence === "settled" ? Promise.resolve() : new Promise<void>(() => {}),
            }
          : {}),
      });
      const chatAbortControllers = new Map([[runId, entry]]);
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
      const deps = createGatewayCloseTestDeps({
        chatAbortControllers,
        ...(callerPending
          ? {}
          : { getPendingReplyCount: vi.fn().mockReturnValueOnce(1).mockReturnValue(0) }),
        markMainSessionsAbortedForRestart,
      });
      const closing = closeGateway(deps)({
        reason: "gateway restarting",
        restartExpectedMs: 123,
        drainTimeoutMs: 0,
      });
      if (persistence === "pending") {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const result = await closing;
      if (callerPending) {
        expect(result.warnings).toContain("restart-reply-drain");
      }
      expect(entry.controller.signal.aborted).toBe(true);
      expect(chatAbortControllers.size).toBe(0);
      expect(markMainSessionsAbortedForRestart).toHaveBeenCalledOnce();
      expect(firstMockCall(markMainSessionsAbortedForRestart)?.[0]?.activeRuns).toEqual(
        persistence === "settled"
          ? []
          : [
              {
                runId,
                lifecycleGeneration: "generation-1",
                sessionKey,
                sessionId,
                observedAt: expect.any(Number),
              },
            ],
      );
      if (persistence === "untracked") {
        expect(vi.mocked(deps.broadcast).mock.calls.some(([event]) => event === "chat")).toBe(
          false,
        );
        expect(deps.nodeSendToSession).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for slow restart marker persistence before cancelling active runs", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const marker = createDeferredCore();
    const chatAbortControllers = createAbortEntries({
      "active-run": {
        controller,
        sessionId: "active-session-id",
        sessionKey: "agent:main:active",
        lifecycleGeneration: "generation-1",
      },
    });
    const close = createGatewayCloseHandler({
      chatAbortControllers,
      getPendingReplyCount: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
      markMainSessionsAbortedForRestart: async () => {
        await marker.promise;
      },
    });
    let closeSettled = false;
    const closing = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    }).then((result) => {
      closeSettled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(closeSettled).toBe(false);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      marker.resolve();
      await closing;
    }
    expect((await closing).warnings).toContain("restart-main-session-marker");
    expect(controller.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
  });

  it("marks failed terminal persistence after the run guard is gone", async () => {
    let activeDuringMark = false;
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(
      async (params) => {
        const run = params.activeRuns[0];
        activeDuringMark = run ? params.isActiveRun(run) : false;
      },
    );
    const restartRecoveryCandidates = new Map([
      [
        "failed-persistence-run",
        {
          runId: "failed-persistence-run",
          lifecycleGeneration: "generation-1",
          sessionKey: "agent:main:failed-persistence",
          sessionId: "failed-persistence-session",
        },
      ],
    ]);
    const close = createGatewayCloseHandler({
      markMainSessionsAbortedForRestart,
      restartRecoveryCandidates,
      resolveActiveSessionIdForKey: () => "rotated-persistence-session",
    });

    await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    const markerCall = firstMockCall(markMainSessionsAbortedForRestart);
    expect(markerCall?.[0]?.activeRuns).toEqual([
      {
        runId: "failed-persistence-run",
        lifecycleGeneration: "generation-1",
        sessionKey: "agent:main:failed-persistence",
        sessionId: "rotated-persistence-session",
        observedAt: expect.any(Number),
      },
    ]);
    expect(activeDuringMark).toBe(true);
    expect(restartRecoveryCandidates.size).toBe(0);
  });

  it("disposes Code Mode runs before agent and bundle runtimes during shutdown", async () => {
    const closeOrder: string[] = [];
    mocks.disposeAllCodeModeRuns.mockImplementation(() => {
      closeOrder.push("code-mode-runs");
    });
    for (const [dispose, label] of [
      [mocks.disposeAgentHarnesses, "agent-harnesses"],
      [mocks.closeProviderTransportDispatcherPool, "provider-transport-dispatchers"],
      [mocks.disposeAllSessionMcpRuntimes, "bundle-mcp"],
      [mocks.disposeAllBundleLspRuntimes, "bundle-lsp"],
      [mocks.drainRetainedEmbeddingProviders, "embedding-providers"],
    ] as const) {
      dispose.mockImplementation(async () => {
        closeOrder.push(label);
      });
    }
    const tailscaleCleanup = vi.fn(async () => {
      closeOrder.push("tailscale");
    });
    const lifecycleUnsub = vi.fn();
    const transcriptUnsub = vi.fn();
    const deps = createGatewayCloseTestDeps({
      tailscaleCleanup,
      lifecycleUnsub,
      transcriptUnsub,
      httpServer: {
        close: (callback: (err?: Error | null) => void) => {
          closeOrder.push("http-server");
          callback(null);
        },
        closeIdleConnections: vi.fn(),
      } as never,
    });
    assert(deps.maintenance);
    const { stopPeriodicTasks } = deps.maintenance;
    const close = closeGateway(deps);

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(transcriptUnsub).toHaveBeenCalledTimes(1);
    expect(stopPeriodicTasks).toHaveBeenCalledTimes(1);
    expect(closeOrder).toEqual([
      "code-mode-runs",
      "agent-harnesses",
      "provider-transport-dispatchers",
      "bundle-mcp",
      "bundle-lsp",
      "http-server",
      "tailscale",
      "embedding-providers",
    ]);
  });

  it.each([
    { label: "bundle-mcp", dispose: mocks.disposeAllSessionMcpRuntimes },
    { label: "embedding-providers", dispose: mocks.drainRetainedEmbeddingProviders },
  ])(
    "continues independent teardown while $label cleanup is pending",
    async ({ label, dispose }) => {
      vi.useFakeTimers();
      const cleanup = createDeferredCore();
      dispose.mockReturnValue(cleanup.promise);
      const httpClose = vi.fn((callback: (error?: Error | null) => void) => callback(null));
      const close = createGatewayCloseHandler({
        httpServer: createHttpServer(httpClose) as never,
      });
      const closePromise = close({ reason: "test shutdown" });
      try {
        if (label === "bundle-mcp") {
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.disposeAllBundleLspRuntimes).toHaveBeenCalledOnce();
          expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.disposeAllBundleLspRuntimes.mock.invocationCallOrder[0]!,
          );
        }
        await vi.advanceTimersByTimeAsync(5_000);
        expect(httpClose).toHaveBeenCalledOnce();
        expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
        await closePromise;
      }
      expect((await closePromise).warnings).toContain(label);
    },
  );

  it.each([true, false])(
    "bounds websocket close beyond grace (tracked client: %s)",
    async (trackedClient) => {
      vi.useFakeTimers();
      let closeCallback: (() => void) | undefined;
      const terminate = vi.fn(() => closeCallback?.());
      const close = createGatewayCloseHandler({
        wss: {
          clients: new Set(trackedClient ? [{ terminate }] : []),
          close: (cb: () => void) => {
            closeCallback = cb;
          },
        } as never,
      });
      const closing = close({ reason: "test shutdown" });
      await vi.advanceTimersByTimeAsync(
        WEBSOCKET_CLOSE_GRACE_MS + (trackedClient ? 0 : WEBSOCKET_CLOSE_FORCE_CONTINUE_MS),
      );
      expect((await closing).warnings).toContain("websocket-server");
      expect(terminate).toHaveBeenCalledTimes(trackedClient ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("records a warning when a websocket client close throws", async () => {
    const clients = new Set<GatewayCloseClient>([
      {
        socket: {
          close: vi.fn(() => {
            throw new Error("already closed");
          }),
        },
      },
      { socket: { close: vi.fn() } },
    ]);
    const close = createGatewayCloseHandler({ clients });

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("ws-clients");
    expect(clients.size).toBe(0);
  });

  it.each([
    { settles: true, multiple: false },
    { settles: false, multiple: true },
  ])(
    "forces lingering HTTP close (settles: $settles, multiple: $multiple)",
    async ({ settles, multiple }) => {
      vi.useFakeTimers();
      let callback: ((error?: Error | null) => void) | undefined;
      const server = {
        ...createHttpServer(
          vi.fn((cb) => {
            callback = cb;
          }),
        ),
        closeAllConnections: vi.fn(() => {
          if (settles) {
            callback?.(null);
          }
        }),
      };
      const laterServer = createHttpServer();
      const tailscaleCleanup = vi.fn(async () => undefined);
      const close = createGatewayCloseHandler({
        ...(multiple
          ? { httpServers: [server as never, laterServer as never] }
          : { httpServer: server as never }),
        tailscaleCleanup,
      });
      const label = multiple ? "http-server[0]" : "http-server";
      const closing = close({ reason: "test shutdown" });
      const rejection = settles
        ? undefined
        : expect(closing).rejects.toThrow(
            `${label} close still pending after forced connection shutdown (5000ms)`,
          );
      await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce());
      if (multiple) {
        expect(laterServer.close).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS);
      expect(server.closeAllConnections).toHaveBeenCalledOnce();
      if (settles) {
        expect((await closing).warnings).toContain("http-server");
        expect(vi.getTimerCount()).toBe(0);
      } else {
        await vi.advanceTimersByTimeAsync(HTTP_CLOSE_FORCE_WAIT_MS);
        await rejection;
      }
      expect(tailscaleCleanup).toHaveBeenCalledOnce();
    },
  );

  it.each(["failed", "unbound"] as const)(
    "classifies %s HTTP listener close callbacks",
    async (outcome) => {
      const error =
        outcome === "failed"
          ? new Error("port busy")
          : Object.assign(new Error("Server is not running."), { code: "ERR_SERVER_NOT_RUNNING" });
      const server = createHttpServer(vi.fn((cb) => cb(error)));
      const close = createGatewayCloseHandler(
        outcome === "failed"
          ? {
              httpServers: [createHttpServer() as never, server as never],
            }
          : { httpServer: server as never },
      );
      const result = await close({ reason: "test shutdown" });
      if (outcome === "failed") {
        expect(result.warnings).toContain("http-server[1]");
        expect(result.warnings).not.toContain("http-server[0]");
      } else {
        expect(result.warnings).toStrictEqual([]);
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
