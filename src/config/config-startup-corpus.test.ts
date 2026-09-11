import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { applyLegacyCompatibilityStep } from "../commands/doctor/shared/config-flow-steps.js";
import { normalizeCompatibilityConfigValues } from "../commands/doctor/shared/legacy-config-core-migrate.js";
import { loadGatewayStartupConfigSnapshot } from "../gateway/server-startup-config-helpers.js";
import { resolveProviderChannelLoginChoice } from "../plugins/provider-login-options.js";
import { createConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.js";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/config-corpus/", import.meta.url));
const fixtureNames = fs
  .readdirSync(corpusDir)
  .filter((name) => name.endsWith(".json"))
  .toSorted();
const expectations: Record<
  string,
  { providers: string[]; model?: string; sourceConfig?: OpenClawConfig }
> = {
  "agent-override.json": { providers: ["openai", "fixture-provider"] },
  "api-key-no-models.json": { providers: ["openai"] },
  "coach-lassi.json": {
    providers: ["openai"],
    sourceConfig: {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
              agentRuntime: { id: "openclaw" },
              params: { responsesServerCompaction: true, responsesCompactEndpoint: true },
            },
          },
        },
      },
    },
  },
  "crossclaw.json": {
    providers: ["openai"],
    sourceConfig: {
      agents: { defaults: { modelPolicy: { allow: ["openai/gpt-5.4"] } } },
      models: { providers: { openai: { baseUrl: "", models: [] } } },
    },
  },
  "custom-models.json": { providers: ["openai"], model: "fixture-model" },
  "empty-providers.json": { providers: ["openai"] },
  "generic-github-token.json": { providers: [] },
  "enabled-only.json": { providers: ["openai"] },
  "falc0n.json": {
    providers: ["openai"],
    sourceConfig: {
      agents: {
        defaults: { modelPolicy: { allow: [] } },
        entries: { main: { model: "openai/gpt-5.4", models: {} } },
      },
    },
  },
  "hamverbot.json": {
    providers: ["openai", "xai"],
    model: "grok-4.3",
    sourceConfig: {
      agents: { defaults: { modelPolicy: { allow: ["openai/*"] } } },
      auth: {
        profiles: {
          "openai:fixture3@example.invalid": { provider: "openai", mode: "oauth" },
          "openai:fixture4@example.invalid": { provider: "openai", mode: "oauth" },
        },
      },
    },
  },
  "legacy-roster.json": { providers: ["openai"] },
  "models-allow.json": { providers: ["fixture-provider"], model: "fixture-model" },
  "oauth-only.json": { providers: ["openai"] },
  "provider-partially-unavailable.json": { providers: ["openai"], model: "gpt-5.4" },
  "operator-container.json": { providers: ["openai", "xai"], model: "grok-4.3" },
  "operator-host.json": { providers: ["xai"], model: "grok-4.3" },
  "peanutto.json": {
    providers: ["openai", "xai", "ollama"],
    model: "minimax-m2.7",
  },
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe("operator config startup corpus", () => {
  it("preserves ambient channel ownership when retiring Copilot discovery", async () => {
    const home = tempDirs.make("openclaw-copilot-owner-");
    const configPath = path.join(home, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { list: [{ id: "worker", default: true }, { id: "other" }] },
        plugins: {
          entries: {
            discord: { enabled: true },
            "github-copilot": { config: { discovery: { enabled: false } } },
          },
        },
      }),
    );
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: home,
      DISCORD_BOT_TOKEN: "synthetic-token",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
    };
    const snapshot = await createConfigIO({
      configPath,
      env,
      homedir: () => home,
      observe: false,
    }).readConfigFileSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    expect(snapshot.config.bindings).toContainEqual({
      agentId: "worker",
      match: { channel: "discord", accountId: "*" },
    });
  });

  it.each([false, true, "legacy", null])(
    "silently removes included Copilot discovery.enabled=%j",
    async (enabled) => {
      const home = tempDirs.make("openclaw-copilot-migration-");
      const configPath = path.join(home, "openclaw.json");
      const legacy = {
        plugins: {
          entries: { "github-copilot": { enabled: true, config: { discovery: { enabled } } } },
        },
      };
      fs.writeFileSync(path.join(home, "copilot.json"), JSON.stringify(legacy));
      fs.writeFileSync(configPath, JSON.stringify({ $include: "copilot.json" }));
      const io = createConfigIO({
        configPath,
        env: { ...process.env, OPENCLAW_STATE_DIR: home },
        homedir: () => home,
        observe: false,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      expect(snapshot.warnings).toEqual([]);
      expect(snapshot.config.plugins?.entries?.["github-copilot"]).toEqual({
        enabled: true,
        config: {},
      });
      const repaired = normalizeCompatibilityConfigValues(snapshot.sourceConfig);
      expect(repaired.config.plugins?.entries?.["github-copilot"]).toEqual({
        enabled: true,
        config: {},
      });
      expect(normalizeCompatibilityConfigValues(repaired.config).changes).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(home, "copilot.json"), "utf8"))).toEqual(legacy);
    },
  );

  it("covers every retained config with an explicit catalog expectation", () => {
    expect(fixtureNames).toEqual(Object.keys(expectations).toSorted());
  });

  it.each(fixtureNames)(
    "%s loads, prepares model rows, and offers provider login",
    async (name) => {
      const home = tempDirs.make("openclaw-config-corpus-");
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      for (const [key, value] of Object.entries({
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_TEST_HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      })) {
        vi.stubEnv(key, value);
      }
      fs.mkdirSync(stateDir, { recursive: true });
      const pluginDir = path.join(home, "external-plugin");
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "fixture-extension",
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: { apiKey: { type: "string" } },
          },
        }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "index.ts"),
        'export default { id: "fixture-extension", register() {} };\n',
      );

      // Relocate sanitized operator paths without removing their config contracts.
      const raw: unknown = JSON.parse(
        fs.readFileSync(path.join(corpusDir, name), "utf8"),
        (_key, value: unknown) =>
          typeof value === "string" && value.startsWith("/home/fixture/")
            ? path.join(home, value.slice("/home/fixture/".length))
            : value,
      );
      fs.writeFileSync(configPath, JSON.stringify(raw));
      const env = { ...process.env };
      const io = createConfigIO({
        configPath,
        env,
        homedir: () => home,
        observe: false,
      });
      const snapshot = await io.readConfigFileSnapshot();
      const migrated = applyLegacyCompatibilityStep({
        snapshot,
        state: {
          cfg: snapshot.sourceConfig,
          candidate: snapshot.sourceConfig,
          pendingChanges: false,
          fixHints: [],
        },
        shouldRepair: true,
        doctorFixCommand: "openclaw doctor --fix",
      });
      const normalized = normalizeCompatibilityConfigValues(migrated.state.candidate, {
        sourceRaw: snapshot.parsed,
        sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      });
      fs.writeFileSync(configPath, JSON.stringify(normalized.config));
      const startup = await loadGatewayStartupConfigSnapshot({
        initialSnapshotRead: await io.readConfigFileSnapshotWithPluginMetadata(),
        minimalTestGateway: false,
        log: console,
      });
      const config = startup.snapshot.config;
      Object.assign(env, config.env?.vars);
      if (
        [
          "enabled-only.json",
          "api-key-no-models.json",
          "oauth-only.json",
          "peanutto.json",
        ].includes(name)
      ) {
        expect(startup.snapshot.sourceConfig.models?.providers?.openai).not.toHaveProperty(
          "models",
        );
      }
      const expected = expectations[name]!;
      if (name === "peanutto.json") {
        expect(startup.snapshot.sourceConfig.models?.providers?.openai?.apiKey).toBe(
          "FAKE_CONFIG_CORPUS_CREDENTIAL",
        );
      }
      if (expected.sourceConfig) {
        expect(startup.snapshot.sourceConfig).toMatchObject(expected.sourceConfig);
      }
      const agentIds = listAgentIds(config);
      expect(agentIds.length).toBeGreaterThan(0);
      if (name === "legacy-roster.json") {
        expect([...migrated.changeLines, ...normalized.changes].length).toBeGreaterThan(0);
        expect(config.agents?.entries?.main).toBeDefined();
      }

      for (const agentId of agentIds) {
        const workspaceDir = path.join(home, "workspaces", agentId);
        const lease = await acquireReadOnlyPreparedModelRuntime(
          {
            config,
            agentId,
            agentDir: path.join(stateDir, "agents", agentId, "agent"),
            workspaceDir,
            env,
            readOnly: true,
            skipCredentials: name !== "generic-github-token.json",
          },
          { catalogMode: name === "generic-github-token.json" ? "live" : "static" },
        );
        try {
          const catalog =
            name === "generic-github-token.json"
              ? await lease.snapshot.loadFullModelCatalog!({ refresh: true })
              : lease.snapshot.modelCatalog;
          if (name === "generic-github-token.json") {
            expect(catalog.providerOutcomes ?? []).not.toContainEqual(
              expect.objectContaining({ provider: "github-copilot" }),
            );
            expect(catalog.refreshFailed).toBeUndefined();
          }
          for (const provider of expected.providers) {
            expect(catalog.entries, `${name}: ${agentId} must expose ${provider}`).toContainEqual(
              expect.objectContaining({ provider }),
            );
          }
          if (expected.model) {
            expect(catalog.entries).toContainEqual(expect.objectContaining({ id: expected.model }));
          }
          const login = resolveProviderChannelLoginChoice(undefined, { config, env, workspaceDir });
          expect(login.status).toBe("providers");
          if (login.status === "providers") {
            expect(login.providers.length).toBeGreaterThan(0);
          }
        } finally {
          lease.release();
        }
      }
    },
  );
});
