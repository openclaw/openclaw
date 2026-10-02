// Extension test setup installs extension-specific mocks and cleanup.
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { installSharedTestSetup } from "./setup.shared.js";

const codexAppServerTestPattern = /\/extensions\/codex\/src\/app-server\/.*\.test\.ts$/;
if (codexAppServerTestPattern.test(expect.getState().testPath?.replaceAll("\\", "/") ?? "")) {
  // Prepare declarations before collection without binding worker-cpu ahead of file mocks.
  await import("../src/test-utils/prepare-compiled-subprocesses.js");
}

const testEnv = installSharedTestSetup({ loadProfileEnv: false });
let restoreUpstreamLinks: (() => void) | undefined;

beforeEach(async (context) => {
  vi.useRealTimers();
  const testPath = expect.getState().testPath?.replaceAll("\\", "/");
  if (codexAppServerTestPattern.test(testPath ?? "")) {
    const { getTrackedWorkerPoolSnapshot } = await vi.importActual<
      typeof import("../src/infra/worker-cpu.js")
    >("../src/infra/worker-cpu.js");
    let stop: (() => Promise<void>) | undefined;
    context.codexAttemptRuntime = {
      readWorkerPools: getTrackedWorkerPoolSnapshot,
      start: async () => {
        const [mcp, clocks] = await Promise.all([
          vi.importActual<typeof import("../src/agents/agent-bundle-mcp-manager-api.js")>(
            "../src/agents/agent-bundle-mcp-manager-api.js",
          ),
          vi.importActual<typeof import("../src/test-utils/gateway-scheduler-clock.js")>(
            "../src/test-utils/gateway-scheduler-clock.js",
          ),
        ]);
        const scheduler = clocks.createTestGatewayScheduler();
        stop = async () => {
          scheduler.beginClose();
          try {
            await mcp.disposeAllSessionMcpRuntimes();
          } finally {
            await scheduler.stop();
          }
        };
        await mcp.setSessionMcpRuntimeScheduler(scheduler);
      },
      stop: async () => {
        await stop?.();
      },
    };
  }
  if (
    !testPath?.match(
      /\/extensions\/codex\/src\/app-server\/upstream-(?:fork-import|session-fork|session-fork-continuation)\.test\.ts$/,
    )
  ) {
    return;
  }
  // Shared initialization calls the core owner; extension fixtures keep their public SDK mocks.
  const [owner, facade] = await Promise.all([
    vi.importActual<typeof import("../src/sessions/session-upstream-links.js")>(
      "../src/sessions/session-upstream-links.js",
    ),
    vi.importMock<typeof import("openclaw/plugin-sdk/session-catalog")>(
      "openclaw/plugin-sdk/session-catalog",
    ),
  ]);
  const upsert = vi
    .spyOn(owner, "upsertSessionUpstreamLink")
    .mockImplementation(facade.upsertSessionUpstreamLink);
  const remove = vi
    .spyOn(owner, "deleteSessionUpstreamLink")
    .mockImplementation(facade.deleteSessionUpstreamLink);
  restoreUpstreamLinks = () => {
    upsert.mockRestore();
    remove.mockRestore();
  };
});

afterEach(() => {
  restoreUpstreamLinks?.();
  restoreUpstreamLinks = undefined;
});

afterAll(async () => {
  const { drainAgentDatabaseResources } = await vi.importActual<
    typeof import("../src/state/openclaw-agent-db-resources.js")
  >("../src/state/openclaw-agent-db-resources.js");
  // File-owned homes must survive until retained Worker leases have been released.
  await drainAgentDatabaseResources({}, async () => {
    const { drainGlobalSingletonLifecycleState } = await vi.importActual<
      typeof import("../src/shared/global-singleton.js")
    >("../src/shared/global-singleton.js");
    await drainGlobalSingletonLifecycleState();
    testEnv.cleanup();
  });
});
