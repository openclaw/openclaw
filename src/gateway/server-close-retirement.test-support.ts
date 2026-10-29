import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { createCliLiveSessionCapability } from "../agents/cli-runner/cli-live-session-registry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { CliBackendLiveSessionHandle } from "../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS } from "../plugins/services.js";
import {
  createServiceRegistration,
  startPluginServices,
} from "../plugins/services.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
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
  }: {
    mocks: Pick<
      typeof import("./server-close.mocks.test-support.js").mocks,
      | "disposeAllSessionMcpRuntimes"
      | "disposeAllBundleLspRuntimes"
      | "drainRetainedEmbeddingProviders"
      | "closeProviderTransportDispatcherPool"
    >;
    sharedStateLifecycle: ReadonlyMap<string, boolean>;
  },
): void {
  it("joins cron cleanup that settles after its grace before retiring shared state", async () => {
    vi.useFakeTimers();
    const cronCleanup = createDeferredCore();
    const stopAndDrain = vi.fn(() => cronCleanup.promise);
    const close = createGatewayCloseHandler({
      cron: { stop: vi.fn(), stopAndDrain },
      lifecycleUnsub: () => cronCleanup.resolve(),
    });
    const closing = close({ reason: "late cron cleanup", exitAfterClose: true });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
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
      const failure = closing.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sharedStateLifecycle.has("open")).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(isGatewayCleanupRetainedError(await failure)).toBe(true);
      expect(stopChannel).toHaveBeenCalledWith("discord");
      expect(sharedStateLifecycle.has("open")).toBe(true);
      expect(clearSecretsRuntimeSnapshot).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(registry);
      expect(stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(sharedStateLifecycle.has("open")).toBe(true);
      expect(clearSecretsRuntimeSnapshot).not.toHaveBeenCalled();
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
      const closePromise = close({ reason: "test shutdown", exitAfterClose: true }).catch(
        (error: unknown) => error,
      );
      try {
        if (label === "bundle-mcp") {
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.disposeAllBundleLspRuntimes).toHaveBeenCalledOnce();
          expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.disposeAllBundleLspRuntimes.mock.invocationCallOrder[0]!,
          );
        }
        // Disposal, the retained-work join, and the final cleanup join each have a grace.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(isGatewayCleanupRetainedError(await closePromise)).toBe(true);
        expect(httpClose).toHaveBeenCalledOnce();
        expect(sharedStateLifecycle.has("open")).toBe(true);
        expect(mocks.closeProviderTransportDispatcherPool).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
        await closePromise;
      }
      expect(mocks.closeProviderTransportDispatcherPool).not.toHaveBeenCalled();
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
}
