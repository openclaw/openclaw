import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayServer } from "./server-public.js";
import { createStartupTestState } from "./server-startup.test-support.js";

let state: Awaited<ReturnType<typeof createStartupTestState>> | undefined;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
let server: GatewayServer | undefined;
const pluginId = "canary-startup-fixture";
let loadedPlugin: { id: string; status: string } | undefined;
const deferredCalls: string[] = [];

function rejectDeferredWork(name: string): never {
  deferredCalls.push(name);
  throw new Error(`Update canary started deferred work: ${name}`);
}

beforeAll(async () => {
  claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  state = await createStartupTestState("gateway-update-canary-startup", {
    OPENCLAW_GATEWAY_PASSWORD: undefined,
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  });
  Object.assign(
    state.envVars,
    buildUpdateRehearsalPathEnv(state.stateDir),
    buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
  );
  state.applyEnv();
  const servingRoot = state.path("serving");
  const credential = path.join(servingRoot, "credentials", "fixture", "token");
  await fs.mkdir(path.dirname(credential), { recursive: true, mode: 0o700 });
  await fs.writeFile(credential, "synthetic-real-provider-value", { mode: 0o600 });
  const resolver = await state.writeText(
    "resolver.mjs",
    `#!${process.execPath}
     import fs from "node:fs";
     import path from "node:path";
     fs.writeFileSync(${JSON.stringify(state.path("provider-executed"))}, "executed");
     const value = fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR, "credentials", "fixture", "token"), "utf8");
     process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { "talk/key": value } }));`,
  );
  await fs.chmod(resolver, 0o700);
  const command = process.platform === "win32" ? process.execPath : resolver;
  const args = process.platform === "win32" ? [resolver] : [];
  const provider = {
    source: "exec" as const,
    command,
    args,
    trustedDirs: [path.dirname(command)],
    passEnv: ["OPENCLAW_STATE_DIR"],
  };
  await expect(
    resolveSecretRefString(
      { source: "exec", provider: "vault", id: "talk/key" },
      {
        config: { secrets: { providers: { vault: provider } } },
        env: { OPENCLAW_STATE_DIR: servingRoot },
      },
    ),
  ).resolves.toBe("synthetic-real-provider-value");
  await fs.unlink(state.path("provider-executed"));
  await state.writeJson("plugin/package.json", { openclaw: { extensions: ["./index.mjs"] } });
  await state.writeJson("plugin/openclaw.plugin.json", {
    id: pluginId,
    activation: { onStartup: true },
    configContracts: { secretInputs: { paths: [{ path: "apiKey" }] } },
    configSchema: { type: "object", properties: { apiKey: {} } },
  });
  await state.writeText(
    "plugin/index.mjs",
    `export default { id: "${pluginId}", register() {} };\n`,
  );
  await state.writeConfig({
    logging: { file: state.statePath("canary.log") },
    secrets: {
      providers: {
        vault: provider,
      },
    },
    talk: {
      realtime: {
        provider: "openai",
        providers: { openai: { apiKey: { source: "exec", provider: "vault", id: "talk/key" } } },
      },
    },
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
      entries: {
        [pluginId]: {
          enabled: true,
          config: { apiKey: { source: "exec", provider: "vault", id: "talk/key" } },
        },
      },
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
      const {
        pluginRegistry: { plugins: registered },
      } = await result.value;
      loadedPlugin ??= registered.find((item) => item.id === pluginId && item.status === "loaded");
    }
  }
});

afterAll(() =>
  runQaGatewayFixture(
    async () => server?.close({ reason: "update canary startup proof complete" }),
    () => vi.restoreAllMocks(),
    () => state?.cleanup(),
    () => claim?.release(),
  ),
);

it("serves candidate readiness without starting normal Gateway maintenance", async () => {
  const health = { startupz: { status: "started" }, readyz: { ready: true } };
  for (const [route, body] of Object.entries(health)) {
    const response = await fetch(`http://127.0.0.1:${claim!.port}/${route}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(body);
  }
  expect(loadedPlugin).toMatchObject({ id: pluginId, status: "loaded" });
  expect(deferredCalls).toEqual([]);
  await expect(fs.access(state!.path("provider-executed"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.readFile(state!.path("serving", "credentials", "fixture", "token"), "utf8")).toBe(
    "synthetic-real-provider-value",
  );
  await expect(
    fs.access(state!.statePath("credentials", "fixture", "token")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(state!.configPath, "utf8")).not.toContain(
    "synthetic-real-provider-value",
  );
  const persisted = JSON.parse(await fs.readFile(state!.configPath, "utf8"));
  expect(persisted.talk.realtime.providers.openai.apiKey).toEqual({
    source: "exec",
    provider: "vault",
    id: "talk/key",
  });
});
