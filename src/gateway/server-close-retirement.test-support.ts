import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { createCliLiveSessionCapability } from "../agents/cli-runner/cli-live-session-registry.js";
import { enqueueSwarmRun } from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { CliBackendLiveSessionHandle } from "../plugins/cli-backend.types.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  createGatewayCloseTestHandlerFactory,
  GatewayCloseParams,
} from "./server-close.test-support.js";

type GatewayCloseHandler = ReturnType<ReturnType<typeof createGatewayCloseTestHandlerFactory>>;

export function registerGatewayResourceRetirementTests(
  createGatewayCloseHandler: (overrides?: Partial<GatewayCloseParams>) => GatewayCloseHandler,
): void {
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
      const onRemoved = vi.fn(() => Promise.reject(failure));
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
        testing.reset();
      }
    },
  );
}
