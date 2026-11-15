import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { createCliLiveSessionCapability } from "../agents/cli-runner/cli-live-session-registry.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { CliBackendLiveSessionHandle } from "../plugins/cli-backend.types.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS } from "../plugins/services.js";
import {
  createServiceRegistration,
  startPluginServices,
} from "../plugins/services.test-support.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.types.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { formatGatewayPendingCloseSteps } from "./restart-trace.js";
import type {
  createGatewayCloseTestHandlerFactory,
  GatewayCloseParams,
} from "./server-close.test-support.js";
import { isGatewayCleanupRetainedError } from "./server-shutdown.js";

type GatewayCloseHandler = ReturnType<ReturnType<typeof createGatewayCloseTestHandlerFactory>>;

export function registerGatewayResourceRetirementTests(
  createGatewayCloseHandler: (overrides?: Partial<GatewayCloseParams>) => GatewayCloseHandler,
  {
    mocks,
    sharedStateLifecycle,
    resolveGatewayContext,
    createHeldCloseSource,
  }: {
    mocks: Pick<
      typeof import("./server-close.mocks.test-support.js").mocks,
      | "disposeAllSessionMcpRuntimes"
      | "disposeAllBundleLspRuntimes"
      | "drainRetainedEmbeddingProviders"
      | "closeProviderTransportDispatcherPool"
      | "disposeAgentHarnesses"
      | "triggerInternalHook"
      | "logInfo"
      | "logWarn"
    >;
    sharedStateLifecycle: Map<string, boolean>;
    resolveGatewayContext: GatewayCloseParams["resolveGatewayContext"];
    createHeldCloseSource: (runId: string) => Promise<{
      source: RpcSourceRef;
      release: (() => void) | undefined;
    }>;
  },
): void {
  it("logs bounded admissions pending facts without session or run identifiers", async () => {
    const admissions = await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const held = await createHeldCloseSource(`private-run-${index}-${"x".repeat(1_000)}`);
        const target = held.source.input.mailbox.owner.target;
        assert(target);
        const effect = await beginSessionEffect({
          target,
          sourceInput: held.source.input,
          operation: held.source.input.claim!.operation!,
          resolveGatewayContext,
          isSettling: () => false,
          assertAllowed() {},
        });
        return { ...held, effect };
      }),
    );
    vi.useFakeTimers();
    const closing = createGatewayCloseHandler()({ exitAfterClose: true });
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      const pending = mocks.logWarn.mock.calls
        .map(([message]) => String(message))
        .filter((message) =>
          message.startsWith("session-admissions: resources remain after grace"),
        );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toContain('"effects":40');
      expect(pending[0]).toContain('"phase":"acquired"');
      expect(pending[0]).toContain('"sourcePhase":');
      expect(pending[0]).toContain('"operationPhase":');
      expect(pending[0]).toContain('"settling":false');
      expect(pending[0]).toContain('"interrupted":true');
      const span = mocks.logInfo.mock.calls
        .map(([message]) => String(message))
        .find(
          (message) =>
            message.startsWith("shutdown pending:") &&
            message.includes("restart.close.session-admissions="),
        );
      expect(span).toContain("effects=40.0 phase=acquired");
      expect(span).not.toMatch(/private-run|agent:main|sessionKey|runId/);
      expect(pending[0]).not.toMatch(/private-run|agent:main|sessionKey|runId/);
      expect(pending[0]!.length).toBeLessThan(300);
    } finally {
      for (const { release, effect } of admissions) {
        effect.release();
        release?.();
      }
      await closing;
    }
  });

  it("joins cron persistence past both grace warnings and then retires shared state", async () => {
    vi.useFakeTimers();
    const cronCleanup = createDeferredCore();
    const stopAndDrain = vi.fn(() => cronCleanup.promise);
    const close = createGatewayCloseHandler({
      cron: { stop: vi.fn(), stopAndDrain },
    });
    const closing = close({ reason: "late cron cleanup", exitAfterClose: true });
    try {
      await vi.advanceTimersByTimeAsync(12_000);
      expect(sharedStateLifecycle.has("open")).toBe(true);
      cronCleanup.resolve();
      const result = await closing;
      expect(stopAndDrain).toHaveBeenCalledOnce();
      expect(result.warnings).toContain("cron");
      expect(sharedStateLifecycle.has("open")).toBe(false);
    } finally {
      cronCleanup.resolve();
      await closing;
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
      const stopChannel = vi.fn(async () => {});
      const close = createGatewayCloseHandler({
        channelIds: ["discord"],
        pluginServices,
        clearSecretsRuntimeSnapshot,
        stopChannel,
      });
      closing = close({
        reason: "gateway restarting",
        restartExpectedMs: 1_500,
        exitAfterClose: true,
      });
      let closed = false;
      void closing
        .finally(() => {
          closed = true;
        })
        .catch(() => {});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sharedStateLifecycle.has("open")).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(closed).toBe(false);
      expect(stopChannel).toHaveBeenCalledWith("discord");
      expect(sharedStateLifecycle.has("open")).toBe(true);
      expect(clearSecretsRuntimeSnapshot).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(registry);
      expect(stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await closing;
      expect(sharedStateLifecycle.has("open")).toBe(false);
      expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve();
      await Promise.allSettled([strictStopping, closing]);
    }
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
        httpServer: { close: httpClose, closeIdleConnections: vi.fn() } as never,
      });
      let closed = false;
      const closePromise = close({ reason: "test shutdown", exitAfterClose: true }).finally(() => {
        closed = true;
      });
      try {
        if (label === "bundle-mcp") {
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.disposeAllBundleLspRuntimes).toHaveBeenCalledOnce();
          expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.disposeAllBundleLspRuntimes.mock.invocationCallOrder[0]!,
          );
        }
        // Late disposal must retain state without preventing independent transport cleanup.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(closed).toBe(false);
        expect(httpClose).toHaveBeenCalledOnce();
        expect(sharedStateLifecycle.has("open")).toBe(true);
        expect(mocks.closeProviderTransportDispatcherPool).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
        await closePromise;
      }
      expect(mocks.closeProviderTransportDispatcherPool).toHaveBeenCalledOnce();
    },
  );

  it("retires warm CLI processes and joins their resource cleanup during shutdown", async () => {
    const context = buildPreparedCliRunContext({ sessionId: "shutdown-warm-cli" });
    const admission = prepareSystemAgentRunAdmission(
      {},
      context.params.runId,
      "main",
      "shutdown-test",
    );
    context.params.admittedRunContext = await admission.admit("plugin-harness");
    const child = spawn(process.execPath, [
      "-e",
      "process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ]);
    const exited = once(child, "close").then(() => undefined);
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const capability = createCliLiveSessionCapability({
      context,
      argv: [process.execPath],
      env: {},
      beginCapture() {},
      abortSignal: new AbortController().signal,
      claimResources: () => async () => {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      },
    });
    const handle: CliBackendLiveSessionHandle = {
      generation: "shutdown-warm-cli",
      fingerprint: capability.fingerprint,
      isIdle: () => true,
      close: () => {
        capability.remove(handle);
        child.kill("SIGTERM");
      },
      waitForExit: () => exited,
    };
    let closing: Promise<unknown> | undefined;
    try {
      await once(child.stdout!, "data");
      capability.register(handle);
      admission.close();
      closing = createGatewayCloseHandler()({ reason: "warm CLI shutdown" });
      await Promise.race([
        cleanupEntered.promise,
        closing.then(() => {
          throw new Error("Gateway closed without retiring its warm CLI process");
        }),
      ]);
      expect(isProcessAlive(child.pid!)).toBe(false);
      let settled = false;
      void closing.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseCleanup.resolve();
      await closing;
    } finally {
      handle.close("abort");
      releaseCleanup.resolve();
      await exited;
      await closing;
      admission.close();
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
    let finalClose: ReturnType<GatewayCloseHandler> | undefined;
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

  it.each(["shutdown", "pre-restart", "harness", "sdk", "session"] as const)(
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
      const reads: unknown[] = [];
      const failures: unknown[] = [];
      const cleanup = vi.fn(async () => {
        entered.resolve();
        try {
          await release.promise;
          reads.push(database.db.prepare("SELECT 1 AS value").get());
          for (const db of [sdkDatabase, preparedDatabase]) {
            expect(db.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
          }
        } catch (error) {
          failures.push(error);
        }
      });
      const eventKey = `gateway:${owner === "pre-restart" ? "pre-restart" : "shutdown"}`;
      if (owner === "session") {
        const { source, release: releaseSource } = await createHeldCloseSource("retained-session");
        source.input.abortSignal.addEventListener(
          "abort",
          () => void cleanup().then(releaseSource),
        );
      } else if (owner === "sdk") {
        await sdkHost.track(async () => {
          void trackAsyncWork(cleanup);
        });
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
      const close = createGatewayCloseHandler({
        closeSdkResources: () => sdkHost.close(),
        drainSdkWork: () => sdkHost.drainWork(),
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let closed = false;
      const closing = close({
        exitAfterClose: true,
        ...(owner === "pre-restart" ? { restartExpectedMs: 1000 } : {}),
      })
        .catch((error: unknown) => error)
        .finally(() => {
          closed = true;
        });
      try {
        await entered.promise;
        // Advance the owner's grace and both retained-work joins.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(closed).toBe(owner === "sdk");
        if (owner === "sdk") {
          expect(isGatewayCleanupRetainedError(await closing)).toBe(true);
        }
        if (owner === "session") {
          expect(formatGatewayPendingCloseSteps()).toContain("session-admissions");
        }
        expect(database.db.isOpen).toBe(true);
        expect([sdkDatabase.isOpen, preparedDatabase.isOpen]).toEqual([true, true]);
        expect(sdkDisposalReads).toEqual([]);
        expect(sharedStateLifecycle.has("open")).toBe(true);
      } finally {
        release.resolve();
        await cleanup.mock.results[0]?.value;
        await closing;
        await sdkHost.close().catch(() => undefined);
        unregisterPrepared();
        for (const db of [sdkDatabase, preparedDatabase]) {
          if (db.isOpen) {
            db.close();
          }
        }
        hooks.unregisterInternalHook(eventKey, cleanup);
        vi.useRealTimers();
        await closeOpenClawStateDatabaseAsync();
        await state.cleanup();
        sharedStateLifecycle.clear();
      }
      expect(failures).toEqual([]);
      expect(reads).toEqual([{ value: 1 }]);
    },
  );
}
