import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayServer } from "./server-public.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
let server: GatewayServer | undefined;
const loadedPlugins: string[] = [];
const deferredCalls: string[] = [];

function rejectDeferredWork(name: string): never {
  deferredCalls.push(name);
  throw new Error(`Update canary started deferred work: ${name}`);
}

beforeAll(async () => {
  claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  state = await createOpenClawTestState({
    label: "gateway-update-canary-startup",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
    },
  });
  const pluginId = "canary-startup-fixture";
  await state.writeJson("plugin/package.json", {
    name: pluginId,
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  });
  await state.writeJson("plugin/openclaw.plugin.json", {
    id: pluginId,
    activation: { onStartup: true },
    configSchema: { type: "object", properties: {} },
  });
  await state.writeText(
    "plugin/index.mjs",
    `export default { id: "${pluginId}", register() {} };\n`,
  );
  await state.writeConfig({
    agents: { defaults: { model: { primary: "openai/gpt-4.1" } } },
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "canary-startup-test-token" },
      controlUi: { enabled: false },
    },
    cron: { enabled: false, triggers: { enabled: false } },
    discovery: { mdns: { mode: "off" } },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true } },
      load: { paths: [state.statePath("plugin")] },
      slots: { memory: "none" },
    },
  });

  const [cliShim, githubCleanup, plugins, workers, projection, lifetime, tasks, discovery, skills] =
    await Promise.all([
      import("../infra/openclaw-cli-shim.js"),
      import("../agents/github-tool-profile-cleanup.js"),
      import("./server-startup-plugins.js"),
      import("./server-worker-environment-startup.js"),
      import("./session-row-projection.js"),
      import("./server-lifetime-sidecars.js"),
      import("../tasks/runtime-internal.js"),
      import("./server-discovery-runtime.js"),
      import("../skills/runtime/remote.js"),
    ]);
  vi.spyOn(cliShim, "prepareGatewayAgentCliShim").mockImplementation(() =>
    rejectDeferredWork("agent CLI shim"),
  );
  vi.spyOn(githubCleanup, "cleanupRetiredManagedGitHubProfiles").mockImplementation(() =>
    rejectDeferredWork("managed GitHub profile cleanup"),
  );
  vi.spyOn(plugins, "runGatewayStartupMaintenance").mockImplementation(() =>
    rejectDeferredWork("channel and session maintenance"),
  );
  vi.spyOn(workers, "loadGatewayWorkerEnvironmentStartupState").mockImplementation(() =>
    rejectDeferredWork("worker environment recovery"),
  );
  vi.spyOn(projection, "createSessionRowProjection").mockImplementation(() =>
    rejectDeferredWork("session catalog hydration"),
  );
  vi.spyOn(lifetime, "attachInitialGatewayLifetimeSidecars").mockImplementation(() =>
    rejectDeferredWork("initial lifetime sidecars"),
  );
  vi.spyOn(tasks, "ensureTaskRuntimeStateReady").mockImplementation(() =>
    rejectDeferredWork("task runtime preparation"),
  );
  vi.spyOn(discovery, "startGatewayDiscovery").mockImplementation(() =>
    rejectDeferredWork("discovery"),
  );
  vi.spyOn(skills, "primeRemoteSkillsCache").mockImplementation(() =>
    rejectDeferredWork("remote skills warmup"),
  );
  const pluginLoad = vi.spyOn(plugins, "loadGatewayStartupPluginRuntime");
  await withAgentDatabaseStartupAdmission(async (admission) => {
    vi.spyOn(admission, "activate").mockImplementation(() =>
      rejectDeferredWork("deferred agent database preparation"),
    );
    const { startGatewayServer } = await import("./server.js");
    server = await startGatewayServer(claim!.port, {
      updateCanary: true,
      bind: "loopback",
      controlUiEnabled: false,
    });
    await server.startupSettled;
  });
  for (const result of pluginLoad.mock.results) {
    if (result.type === "return") {
      const loaded = await result.value;
      loadedPlugins.push(
        ...loaded.pluginRegistry.plugins
          .filter((plugin) => plugin.status === "loaded")
          .map((plugin) => plugin.id),
      );
    }
  }
});

afterAll(async () => {
  try {
    await server?.close({ reason: "update canary startup proof complete" });
  } finally {
    vi.restoreAllMocks();
    try {
      await state?.cleanup();
    } finally {
      await claim?.release();
    }
  }
});

it("serves candidate readiness without starting normal Gateway maintenance", async () => {
  const startup = await fetch(`http://127.0.0.1:${claim!.port}/startupz`);
  expect(startup.status).toBe(200);
  await expect(startup.json()).resolves.toMatchObject({ status: "started" });
  const readiness = await fetch(`http://127.0.0.1:${claim!.port}/readyz`);
  expect(readiness.status).toBe(200);
  await expect(readiness.json()).resolves.toMatchObject({ ready: true });
  expect(loadedPlugins).toContain("canary-startup-fixture");
  expect(deferredCalls).toEqual([]);
});
