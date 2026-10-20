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

  const [cli, gh, plugins, workers, rows, sidecars, discovery, skills, subagents] =
    await Promise.all([
      import("../infra/openclaw-cli-shim.js"),
      import("../agents/github-tool-profile-cleanup.js"),
      import("./server-startup-plugins.js"),
      import("./server-worker-environment-startup.js"),
      import("./session-row-projection.js"),
      import("./server-lifetime-sidecars.js"),
      import("./server-discovery-runtime.js"),
      import("../skills/runtime/remote.js"),
      import("../agents/subagents/registry/subagent-registry.js"),
    ]);
  for (const [spy, name] of [
    [vi.spyOn(cli, "prepareGatewayAgentCliShim"), "agent CLI shim"],
    [vi.spyOn(gh, "cleanupRetiredManagedGitHubProfiles"), "managed GitHub profile cleanup"],
    [vi.spyOn(plugins, "runGatewayPostReadyStartupMaintenance"), "channel and session maintenance"],
    [vi.spyOn(workers, "loadGatewayWorkerEnvironmentStartupState"), "worker environment recovery"],
    [vi.spyOn(rows, "createSessionRowProjection"), "session catalog hydration"],
    [vi.spyOn(sidecars, "attachInitialGatewayLifetimeSidecars"), "initial lifetime sidecars"],
    [vi.spyOn(discovery, "startGatewayDiscovery"), "discovery"],
    [vi.spyOn(skills, "primeRemoteSkillsCache"), "remote skills warmup"],
    [vi.spyOn(subagents, "initSubagentRegistry"), "subagent recovery hydration"],
    [vi.spyOn(subagents, "activateSubagentRegistry"), "subagent recovery activation"],
  ] as const) {
    spy.mockImplementation(() => rejectDeferredWork(name));
  }
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
  const health = { startupz: { status: "started" }, readyz: { ready: true } };
  for (const [route, body] of Object.entries(health)) {
    const response = await fetch(`http://127.0.0.1:${claim!.port}/${route}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(body);
  }
  expect(loadedPlugins).toContain("canary-startup-fixture");
  expect(deferredCalls).toEqual([]);
});
