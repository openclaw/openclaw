import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { registerDispatcher } from "../auto-reply/reply/dispatcher-registry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS } from "../plugins/services.js";
import {
  createServiceRegistration,
  startPluginServices,
} from "../plugins/services.test-support.js";
import type { OpenClawPluginService } from "../plugins/types.js";
import { getProcessSupervisor, type ManagedRun } from "../process/supervisor/index.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  trackSessionControllerSourceWork,
} from "../sessions/session-controller.mailbox.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  recoveryRun,
  registerGatewayCancellationTests,
} from "./server-close-cancellation.test-support.js";
import { registerGatewayResourceRetirementTests } from "./server-close-retirement.test-support.js";
import {
  createGatewayCloseTestDepsFactory,
  createGatewayCloseTestHandlerFactory,
  type GatewayCloseParams,
  createTestChatRunState,
  firstMockCall,
} from "./server-close.test-support.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "./test-helpers.rpc-source.js";

const { mocks } = await vi.hoisted(() => import("./server-close.mocks.test-support.js"));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  const { createMockSubsystemLogger } = await import("../../test/helpers/mock-subsystem-logger.js");
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      createMockSubsystemLogger(subsystem, {
        info: (...args) => mocks.logInfo(...args),
        warn: (...args) => mocks.logWarn(...args),
      }),
  };
});

const sharedStateLifecycle = resolveGlobalMap<string, boolean>(
  Symbol("gateway-close-shared-state"),
  "shared-state",
);
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;
const AGENT_HARNESS_CLOSE_GRACE_MS = 5_000;

const closeGateway = createGatewayCloseTestHandlerFactory(await import("./server-close.js"));
const { isChatAbortMarkerCurrent } = await import("./server-chat-state.js");
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

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory(mocks);

function createGatewayCloseHandler(overrides: Partial<GatewayCloseParams> = {}) {
  return closeGateway(createGatewayCloseTestDeps(overrides));
}

const resolveTestGatewayContext = createGatewayCloseTestDeps().resolveGatewayContext;

async function createCloseSource(
  runId: string,
  metadata: Parameters<typeof createRpcSourceForTest>[0] = {},
  options: Parameters<typeof createRpcSourceForTest>[1] & {
    resolveGatewayContext?: GatewayCloseParams["resolveGatewayContext"];
    holdProducer?: boolean;
  } = {},
) {
  const { resolveGatewayContext = resolveTestGatewayContext, holdProducer, ...identity } = options;
  const source = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
    createRpcSourceForTest(metadata, {
      storeScope: "/synthetic/gateway-close/sessions.sqlite",
      sessionId: runId,
      sessionKey: `agent:main:${runId}`,
      agentId: "main",
      ...identity,
      runId,
    }),
  );
  rpcSourceTesting.set(runId, source);
  const release = identity.phase === "waiting" ? undefined : await claimRpcSourceForTest(source);
  if (release && !holdProducer) {
    source.input.abortSignal.addEventListener("abort", release, { once: true });
  }
  return { source, release };
}

function createHttpServer(
  close = vi.fn((callback: (error?: Error | null) => void) => callback(null)),
) {
  return { close, closeIdleConnections: vi.fn() };
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    sharedStateLifecycle.set("open", true);
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

  registerGatewayResourceRetirementTests(createGatewayCloseHandler, {
    mocks,
    sharedStateLifecycle,
  });

  it.each(["shutdown", "pre-restart", "harness", "sdk"] as const)(
    "retains shared SQLite through actual %s cleanup after grace",
    async (owner) => {
      const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
      const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
        await import("../state/openclaw-state-db.js");
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
        expect(sharedStateLifecycle.has("open")).toBe(true);
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
          expect(database.db.isOpen).toBe(false);
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
          await closeOpenClawStateDatabaseAsync();
          await state.cleanup();
        }
      }
      expect(formatGatewayPendingCloseSteps()).toBe("none");
      expect(cleanup).toHaveBeenCalledOnce();
      expect(failures).toEqual([]);
      expect(reads).toEqual([{ value: 1 }]);
      expect(sharedStateLifecycle.size).toBe(0);
    },
  );

  it.each([false, true])(
    "finishes shared state cleanup after actual SDK disposal rejects (global failure: %s)",
    async (globalFailure) => {
      const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
      const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
        await import("../state/openclaw-state-db.js");
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
        await closeOpenClawStateDatabaseAsync();
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
    expect(deps.stopScheduledServices).toHaveBeenCalledTimes(1);
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
          expect(sharedStateLifecycle.has("open")).toBe(true);
          expect(getActivePluginRegistry()).toBe(registry);
          expect(clearSecretsRuntimeSnapshot).not.toHaveBeenCalled();
        } else {
          const result = await closing;
          expect(result.warnings).toContain("plugin-services");
          expect(stop).toHaveBeenCalledOnce();
          expect(sharedStateLifecycle.size).toBe(0);
          expect(getActivePluginRegistry()).toBeNull();
          expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledOnce();
          expect(await pluginServices.stop()).toEqual({ errors: [failure] });
          expect(stop).toHaveBeenCalledOnce();
        }
        expect(deps.stopScheduledServices).toHaveBeenCalledOnce();
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
      const events: string[] = [];
      const clearSecretsRuntimeSnapshot = vi.fn(() => events.push("clear-secrets"));
      const stopChannel = vi.fn(async (id: string) => {
        events.push(`channel:${id}`);
        if (fails && id === "telegram") {
          throw new Error("telegram stuck");
        }
      });
      const deps = createGatewayCloseTestDeps({
        lifecycleUnsub,
        stopChannel,
        clearSecretsRuntimeSnapshot,
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
        deps.stopScheduledServices,
        deps.stopMediaCleanup,
        deps.chatRunState.clear,
        lifecycleUnsub,
      ]) {
        expect(stop).toHaveBeenCalledOnce();
      }
      expect(stopChannel.mock.calls.map(([id]) => id)).toEqual(["telegram", "discord"]);
      expect(events).toEqual(["channel:telegram", "channel:discord", "clear-secrets"]);
      expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledOnce();
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
        expect(sharedStateLifecycle.has("open")).toBe(true);
        expect(closed).toBe(false);
        if (owner === "updateCheck") {
          expect(mocks.disposeAllCodeModeRuns).not.toHaveBeenCalled();
        }
      } finally {
        stopped.resolve();
        await closing;
      }
      expect(sharedStateLifecycle.size).toBe(0);
      expect(closed).toBe(true);
      if (owner === "updateCheck") {
        expect(mocks.disposeAllCodeModeRuns).toHaveBeenCalledOnce();
      }
    },
  );

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
      expect(sharedStateLifecycle.has("open")).toBe(true);
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
      expect(sharedStateLifecycle.size).toBe(0);
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
      expect(order).toStrictEqual(["reply-drain", "session-end"]);
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

  registerGatewayCancellationTests({
    createClose: createGatewayCloseHandler,
    createSource: createCloseSource,
    resolveGatewayContext: resolveTestGatewayContext,
    setShutdownHook: (hook) => mocks.triggerInternalHook.mockImplementation(hook),
  });

  it("captures a run admitted during restart grace before cancellation", async () => {
    vi.useFakeTimers();
    const graceEntered = createDeferredCore();
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
    const close = createGatewayCloseHandler({
      getPendingReplyCount: () => {
        graceEntered.resolve();
        return 1;
      },
      markMainSessionsAbortedForRestart,
    });
    const closing = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 100,
    });
    await graceEntered.promise;
    const { source } = await createCloseSource("late-grace-run", {
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    expect(isAgentRunRestartAbortReason(source.input.abortSignal.reason)).toBe(true);
    expect(markMainSessionsAbortedForRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRuns: [expect.objectContaining({ runId: "late-grace-run" })],
      }),
    );
  });

  it("stops a Gateway claim before an operation exists without taking a foreign claim", async () => {
    const otherGateway = () => undefined;
    const begin = async (resolver: GatewayCloseParams["resolveGatewayContext"], key: string) => {
      const target = captureSessionTarget({
        storeScope: "/synthetic/gateway-close/claims.sqlite",
        sessionKey: key,
      });
      const input = withPluginRuntimeGatewayContextResolver(resolver, () =>
        reserveSessionControllerSource(key, { target, policy: { mode: "followup" } }),
      );
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      input.abortSignal.addEventListener("abort", () => finish.resolve(), { once: true });
      const work = withSessionTurn(
        { sessionKey: key, target, controllerInput: input },
        async (operation) => {
          expect(operation).toBeUndefined();
          entered.resolve();
          await finish.promise;
        },
      );
      await entered.promise;
      return { input, work, finish };
    };
    const own = await begin(resolveTestGatewayContext, "agent:main:unbound-close");
    const other = await begin(otherGateway, "agent:main:foreign-close");
    try {
      await createGatewayCloseHandler()({
        reason: "gateway restarting",
        restartExpectedMs: 123,
        drainTimeoutMs: 0,
      });
      expect(own.input.abortSignal.aborted).toBe(true);
      expect(other.input.abortSignal.aborted).toBe(false);
    } finally {
      own.finish.resolve();
      other.finish.resolve();
      await Promise.all([own.work, other.work]);
      await Promise.all([own.input.settlement.promise, other.input.settlement.promise]);
    }
  });

  it.each(["shutdown", "finalizing"] as const)(
    "cancels only abortable runs when the %s drain budget is exhausted",
    async (mode) => {
      const finalizing = mode === "finalizing";
      const restart = mode !== "shutdown";
      const runId = finalizing ? "run-finalizing" : "run-1";
      const { source, release } = await createCloseSource(
        runId,
        finalizing ? { projectSessionActive: false } : {},
      );
      if (finalizing) {
        source.input.claim!.operation!.freezeAbort();
      }
      const getPendingReplyCount = vi.fn(() => (restart ? 0 : 1));
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
      const deps = createGatewayCloseTestDeps({
        getPendingReplyCount,
        markMainSessionsAbortedForRestart,
        ...(finalizing
          ? {
              disposeAllCodeModeRuns: () => {
                expect(source.input.abortSignal.aborted).toBe(false);
                expect(source.input.claim?.operation?.result).toBeNull();
                release?.();
              },
            }
          : {}),
      });
      const closing = closeGateway(deps)({
        reason: restart ? "gateway restarting" : "SIGTERM",
        ...(restart ? { restartExpectedMs: 123 } : {}),
        drainTimeoutMs: 0,
      });
      try {
        const result = await closing;
        expect(result.warnings).toContain("restart-reply-drain");
        expect(source.input.abortSignal.aborted).toBe(!finalizing);
        if (!finalizing) {
          expect(isAgentRunRestartAbortReason(source.input.abortSignal.reason)).toBe(true);
        }
        if (!restart) {
          expect(getPendingReplyCount).toHaveBeenCalled();
          expect(markMainSessionsAbortedForRestart).toHaveBeenCalledOnce();
          expect(deps.broadcast).toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({
              runId,
              state: "aborted",
              stopReason: "restart",
            }),
            { sessionKeys: [`agent:main:${runId}`] },
          );
        }
      } finally {
        release?.();
      }
    },
  );

  it("marks current sources before cancelling and clearing timed-out restart replies", async () => {
    vi.useFakeTimers();
    const { source: foreign, release } = await createCloseSource(
      "foreign-gateway-run",
      {},
      {
        resolveGatewayContext: () => undefined,
      },
    );
    onTestFinished(async () => {
      release?.();
      await foreign.input.settlement.promise;
    });
    const events: string[] = [];
    const generation = getAgentEventLifecycleGeneration();
    const { source: chat } = await createCloseSource(
      "run-1",
      { lifecycleGeneration: generation },
      {
        sessionKey: "agent:main:main",
        sessionId: "session-id-1",
      },
    );
    const { source: agent } = await createCloseSource(
      "agent-run-1",
      { lifecycleGeneration: generation, kind: "agent" },
      {
        sessionKey: "agent:main:test:direct:source",
        sessionId: "session-id-2",
      },
    );
    const { source: completed } = await createCloseSource(
      "completed-run",
      {
        lifecycleGeneration: generation,
        projectSessionActive: false,
        projectSessionTerminalPersisted: true,
      },
      { sessionId: "completed-session-id", sessionKey: "agent:main:completed" },
    );
    const { source: stale } = await createCloseSource("stale-run", {
      lifecycleGeneration: generation,
    });
    requestRpcSourceCancellation(stale);
    await stale.input.settlement.promise;
    const { source: hidden } = await createCloseSource("hidden-run", {
      lifecycleGeneration: generation,
      controlUiVisible: false,
      kind: "agent",
    });
    const chatRunState = createTestChatRunState();
    const completedRun = chatRunState.getOrCreate("completed-run");
    const bufferedRun = chatRunState.getOrCreate("run-1");
    bufferedRun.buffer = "partial reply";
    bufferedRun.deltaSentAt = Date.now();
    bufferedRun.assistantScope = {
      itemId: "assistant-1",
      prefix: "",
      boundaryNewlines: 0,
      separatorLength: 0,
    };
    chatRunState.takeBufferDelta("run-1", "par");
    bufferedRun.agentText = {
      assistant: {
        lastSentAt: Date.now(),
        bufferedEvent: { sessionKey: "agent:main:main", payload: {} as never },
      },
    };
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(() => {
      events.push("marker");
    });
    const close = createGatewayCloseHandler({
      chatRunState,
      broadcast,
      nodeSendToSession,
      markMainSessionsAbortedForRestart,
      removeChatRun: vi.fn(() => {
        events.push("abort");
        return {
          sessionKey: "agent:main:main",
          clientRunId: "run-1",
          registeredAtMs: 1_000,
          registeredSequence: 1,
        };
      }),
    });
    const closing = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect((await closing).warnings).toContain("restart-reply-drain");
    expect(rpcSourceTesting.has("run-1")).toBe(false);
    expect(rpcSourceTesting.has("agent-run-1")).toBe(false);
    expect(chatRunState.runs.has("run-1")).toBe(false);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes(
          "restart reply drain timed out after 100ms with chatRuns=4 still active",
        ),
      ),
    ).toBe(true);
    for (const [runId, sessionKey] of [
      ["run-1", "agent:main:main"],
      ["agent-run-1", "agent:main:test:direct:source"],
    ]) {
      const payload = expect.objectContaining({ runId, state: "aborted", stopReason: "restart" });
      expect(broadcast).toHaveBeenCalledWith("chat", payload, { sessionKeys: [sessionKey] });
      expect(nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
    }
    expect(events[0]).toBe("marker");
    expect(markMainSessionsAbortedForRestart).toHaveBeenCalledOnce();
    expect(firstMockCall(markMainSessionsAbortedForRestart)?.[0]?.activeRuns).toEqual(
      [
        recoveryRun("run-1", "agent:main:main", "session-id-1", generation),
        recoveryRun("agent-run-1", "agent:main:test:direct:source", "session-id-2", generation),
        // A terminal write does not settle the caller's retained controller custody.
        recoveryRun("completed-run", "agent:main:completed", "completed-session-id", generation),
      ].map((run) => Object.assign(run, { observedAt: expect.any(Number) })),
    );
    expect(chat.input.abortSignal.aborted).toBe(true);
    expect(agent.input.abortSignal.aborted).toBe(true);
    expect(foreign.input.abortSignal.aborted).toBe(false);
    expect(hidden.input.abortSignal.aborted).toBe(true);
    expect(completed.input.abortSignal.aborted).toBe(true);
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
      const persisted = createDeferredCore();
      if (persistence === "settled") {
        persisted.resolve();
      }
      const { source, release } = await createCloseSource(
        runId,
        {
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          projectSessionActive: false,
          projectSessionTerminalPersisted: callerPending,
          projectSessionTerminalPending: !callerPending,
          ...(persistence === "settled" || persistence === "pending"
            ? {
                projectSessionTerminalPersistence: persisted.promise,
              }
            : {}),
        },
        { sessionId, sessionKey, holdProducer: callerPending },
      );
      // A completed producer still owns its accepted terminal writer until that work settles.
      if (!callerPending) {
        if (persistence !== "settled") {
          trackSessionControllerSourceWork(source.input, persisted.promise);
        }
        const producerSettled = source.input.claim?.operation?.ownerSettlement;
        release?.();
        await producerSettled;
        if (persistence === "settled") {
          await source.input.settlement.promise;
        }
      }
      const markerEntered = createDeferredCore();
      const cancelled = createDeferredCore();
      source.input.abortSignal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(() => {
        markerEntered.resolve();
      });
      const deps = createGatewayCloseTestDeps({
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
      await markerEntered.promise;
      if (callerPending) {
        await cancelled.promise;
        release?.();
      } else {
        persisted.resolve();
      }
      try {
        const result = await closing;
        if (callerPending) {
          expect(result.warnings).toContain("restart-reply-drain");
        }
        expect(markMainSessionsAbortedForRestart).toHaveBeenCalledOnce();
        expect(firstMockCall(markMainSessionsAbortedForRestart)?.[0]?.activeRuns).toEqual(
          persistence === "settled"
            ? []
            : [{ ...recoveryRun(runId, sessionKey, sessionId), observedAt: expect.any(Number) }],
        );
        if (persistence === "untracked") {
          expect(vi.mocked(deps.broadcast).mock.calls.some(([event]) => event === "chat")).toBe(
            false,
          );
          expect(deps.nodeSendToSession).not.toHaveBeenCalled();
        }
      } finally {
        persisted.resolve();
        release?.();
      }
    },
  );

  it("waits for slow restart marker persistence before cancelling active runs", async () => {
    vi.useFakeTimers();
    const { source } = await createCloseSource("active-run", {
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    const marker = createDeferredCore();
    const closing = createGatewayCloseHandler({
      getPendingReplyCount: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
      markMainSessionsAbortedForRestart: () => marker.promise,
    })({ reason: "gateway restarting", restartExpectedMs: 123, drainTimeoutMs: 0 });
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      expect(source.input.abortSignal.aborted).toBe(false);
    } finally {
      marker.resolve();
      await closing;
    }
    expect((await closing).warnings).toContain("restart-main-session-marker");
    expect(source.input.abortSignal.aborted).toBe(true);
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
      "bundle-mcp",
      "bundle-lsp",
      "http-server",
      "tailscale",
      "embedding-providers",
      "provider-transport-dispatchers",
    ]);
  });

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
