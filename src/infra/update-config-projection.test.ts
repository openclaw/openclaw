import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { planLegacyConfigForUpdateChannel } from "../commands/doctor/legacy-config-repair.js";
import { setDeferredPluginMigrationConfigFacts } from "../config/deferred-plugin-migration-config.js";
import { createConfigIO } from "../config/io.factory.js";
import { preparePluginDoctorContractModules } from "../plugins/doctor-contract-preparation.js";
import { projectUpdateConfig } from "./update-config-projection.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let configPath: string;

beforeEach(() => {
  stateDir = dirs.make("deployment-config-projection-");
  configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("HOME", stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_HOME", undefined);
  vi.stubEnv("OPENCLAW_PROFILE", undefined);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
  vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
  vi.stubEnv("DEPLOYMENT_FIXTURE_TOKEN", "fixture-value-must-not-be-persisted");
});

afterEach(() => vi.unstubAllEnvs());

it("does not treat deferred plugin validation as admission for the remaining config", async () => {
  const config = retiredConfig();
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          codex: {
            config: {
              appServer: { loopDetectionPreToolUseRelay: false, requestTimeoutMs: "invalid" },
            },
          },
        },
      },
    }),
  );
  const snapshot = await createConfigIO({
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  setDeferredPluginMigrationConfigFacts(snapshot.sourceConfig, [
    {
      pluginId: "codex",
      reason: "Fixture migration remains deferred.",
      command: "openclaw doctor --fix",
    },
  ]);
  await preparePluginDoctorContractModules({
    config: snapshot.sourceConfig,
    surfaces: ["configRepair"],
    artifactPreservingReadOnly: true,
  });
  expect(planLegacyConfigForUpdateChannel(snapshot)).toBeUndefined();
});

function retiredConfig() {
  return {
    meta: { migrations: { skillWorkshopPlugin: true } },
    agents: { entries: { "controller-test-agent": {} } },
    gateway: { auth: { token: "${DEPLOYMENT_FIXTURE_TOKEN}" } },
    plugins: {
      allow: ["codex"],
      entries: {
        codex: {
          config: { appServer: { requestTimeoutMs: 120_000, loopDetectionPreToolUseRelay: false } },
        },
      },
    },
  };
}

it("projects the candidate's retired Codex key without touching config or agent state", async () => {
  const original = `${JSON.stringify(retiredConfig())}\n`;
  fs.writeFileSync(configPath, original);
  const agentDir = path.join(stateDir, "agents", "controller-test-agent", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const agentDatabase = path.join(agentDir, "openclaw-agent.sqlite");
  fs.writeFileSync(agentDatabase, "not a database: config projection must not inspect this\n");
  const before = fs.readdirSync(stateDir);

  const result = await projectUpdateConfig();

  expect(result).toMatchObject({
    configPath,
    originalSha256: createHash("sha256").update(original).digest("hex"),
    config: {
      gateway: { auth: { token: "${DEPLOYMENT_FIXTURE_TOKEN}" } },
      plugins: { entries: { codex: { config: { appServer: { requestTimeoutMs: 120_000 } } } } },
    },
    changedPaths: ["plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay"],
    changes: [expect.stringContaining("loopDetectionPreToolUseRelay")],
  });
  expect(JSON.stringify(result.config)).not.toContain("loopDetectionPreToolUseRelay");
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  expect(fs.readFileSync(agentDatabase, "utf8")).toBe(
    "not a database: config projection must not inspect this\n",
  );
  expect(fs.readdirSync(stateDir)).toEqual(before);

  fs.writeFileSync(configPath, JSON.stringify(result.config));
  expect(await projectUpdateConfig()).toMatchObject({
    config: result.config,
    changedPaths: [],
    changes: [],
  });
});

it.each([
  { label: "unknown key", source: () => ({ ...retiredConfig(), unknownDeploymentKey: true }) },
  { label: "invalid value", source: () => ({ gateway: { port: "not-a-port" } }) },
  {
    label: "ambiguous transport after migration",
    source: () => ({
      ...retiredConfig(),
      mcp: { servers: { fixture: { command: "never-run", url: "https://example.invalid/mcp" } } },
    }),
  },
  {
    label: "invalid secret command",
    source: () => ({
      secrets: {
        providers: { fixture: { source: "exec", command: "/missing/deployment-secret-command" } },
      },
    }),
  },
  {
    label: "repairable include",
    source: () => ({ $include: "included.json", ...retiredConfig() }),
  },
  { label: "malformed JSON", source: () => "{" },
])("refuses $label without publishing a repair", async ({ source }) => {
  fs.writeFileSync(path.join(stateDir, "included.json"), "{}");
  const value = source();
  const original = typeof value === "string" ? value : JSON.stringify(value);
  fs.writeFileSync(configPath, original);
  await expect(projectUpdateConfig()).rejects.toThrow();
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
});

it("preserves valid includes and an unconfigured file without normalization writes", async () => {
  fs.writeFileSync(path.join(stateDir, "included.json"), "{}");
  for (const config of [{}, { $include: "included.json" }]) {
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(await projectUpdateConfig()).toMatchObject({ config, changedPaths: [], changes: [] });
  }
});
