import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection-resolve.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.js";
import { findLegacyConfigIssues } from "./legacy.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { materializeUtilityModelSeparation } from "./utility-model-separation-migration.js";
import { localProvider as providerFixture } from "./utility-model-separation.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

const localProvider = (...ids: string[]) => ({
  ...providerFixture(...ids),
  api: "openai-completions" as const,
});

function legacyConfig(workspace: string): OpenClawConfig {
  return {
    agents: {
      defaults: { utilityModel: "local-fixture/small" },
      entries: { main: { workspace } },
    },
    models: { providers: { "local-fixture": localProvider() } },
    plugins: { enabled: false },
  };
}

function configIO(home: string, env: NodeJS.ProcessEnv = {}) {
  return createConfigIO({
    configPath: path.join(home, "openclaw.json"),
    env: {
      HOME: home,
      OPENCLAW_STATE_DIR: path.join(home, "state"),
      NODE_ENV: "test",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      ...env,
    },
    homedir: () => home,
    observe: false,
    pluginValidation: "core-only",
  });
}

function fixture() {
  const home = tempDirs.make("openclaw-utility-separation-");
  return {
    home,
    configPath: path.join(home, "openclaw.json"),
    config: legacyConfig(path.join(home, "workspace")),
    io: configIO(home),
  };
}

describe("utility model separation persistence", () => {
  it("round-trips existing string utility settings beside per-agent fallback objects", async () => {
    const { configPath, io } = fixture();
    const agents = {
      ownership: "explicit" as const,
      defaults: { model: "local-fixture/chat", utilityModel: "local-fixture/small" },
      entries: {
        inherited: {},
        worker: { utilityModel: { primary: "helper", fallbacks: ["local-fixture/backup"] } },
        disabled: { utilityModel: "" },
      },
    };
    await fs.writeFile(configPath, JSON.stringify({ agents, plugins: { enabled: false } }));
    const first = await io.readConfigFileSnapshot();
    expect(first.valid).toBe(true);
    expect(first.sourceConfig.agents).toEqual(agents);
    await io.writeConfigFile({ ...first.sourceConfig, gateway: { mode: "local" } });
    const second = await io.readConfigFileSnapshot();
    expect(second.valid).toBe(true);
    expect(second.sourceConfig.agents).toEqual(agents);
  });

  it.each(["fresh", "existing", "included-models"] as const)(
    "preserves previous source intent for a %s config write",
    async (kind) => {
      const { home, configPath, config, io } = fixture();
      const includePath = path.join(home, "models.json");
      const included = JSON.stringify(config.models);
      if (kind !== "fresh") {
        const authored =
          kind === "included-models" ? { ...config, models: { $include: "models.json" } } : config;
        if (kind === "included-models") {
          await fs.writeFile(includePath, included);
        }
        await fs.writeFile(configPath, JSON.stringify(authored));
      }
      const before = await io.readConfigFileSnapshot();
      expect(before.exists).toBe(kind !== "fresh");
      expect(before.sourceConfigBeforeMigrations?.agents?.defaults?.model).toBeUndefined();
      await io.writeConfigFile({ ...config, gateway: { mode: "local", port: 19097 } });

      const after = await io.readConfigFileSnapshot();
      expect(after.valid).toBe(true);
      expect(after.sourceConfig.agents?.defaults?.model).toEqual(
        kind === "fresh" ? undefined : { primary: "local-fixture/small" },
      );
      expect(after.sourceConfig.agents?.defaults?.utilityModel).toBe("local-fixture/small");
      expect(after.sourceConfig.meta?.migrations?.utilityModelSeparation).toBe(true);
      if (kind === "included-models") {
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).models).toEqual({
          $include: "models.json",
        });
        expect(await fs.readFile(includePath, "utf8")).toBe(included);
      }
    },
  );

  it.each([
    { change: "provider", expected: "remaining/second" },
    { change: "selected-row", expected: "local-fixture/second" },
    { change: "replacement", expected: "local-fixture/replacement" },
    { change: "default-row", expected: "local-fixture/small" },
    { change: "all-providers", expected: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}` },
  ])(
    "persists the remaining route after explicit $change removal",
    async ({ change, expected }) => {
      const { configPath, config: previous, io } = fixture();
      const fallbacks = ["backup/model@backup:account"];
      expectDefined(previous.agents?.defaults, "defaults").model = { fallbacks };
      const providers = expectDefined(previous.models?.providers, "providers");
      const provider = expectDefined(providers["local-fixture"], "provider");
      if (change === "selected-row") {
        provider.models.push(...localProvider("second").models);
      } else if (change === "provider") {
        providers.remaining = localProvider("second");
      } else if (change === "default-row") {
        providers[DEFAULT_PROVIDER] = localProvider(DEFAULT_MODEL);
      }
      await fs.writeFile(configPath, JSON.stringify(previous));
      const candidate: OpenClawConfig = {
        ...previous,
        models: {
          providers:
            change === "default-row"
              ? { "local-fixture": provider }
              : change === "all-providers"
                ? {}
                : {
                    [change === "provider" ? "remaining" : "local-fixture"]: localProvider(
                      change === "replacement" ? "replacement" : "second",
                    ),
                  },
        },
      };
      await io.writeConfigFile(candidate);
      const after = await io.readConfigFileSnapshot();
      expect(after.valid).toBe(true);
      expect(after.sourceConfig.agents?.defaults?.model).toEqual({ primary: expected, fallbacks });
      expect(after.sourceConfig.models).toEqual(candidate.models);
      expect(after.sourceConfig.meta?.migrations?.utilityModelSeparation).toBe(true);
    },
  );

  it.each(["${LOCAL_MODEL}", "prefix-${LOCAL_MODEL}"])(
    "retains dynamic catalog selection through a staged and unrelated write: %s",
    async (template) => {
      const { home, configPath, config } = fixture();
      expectDefined(config.models?.providers?.["local-fixture"]?.models[0], "model").id = template;
      expectDefined(config.agents?.defaults, "defaults").utilityModel = `local-fixture/${template}`;
      await fs.writeFile(configPath, JSON.stringify(config));
      const ioForModel = (model: string) => configIO(home, { LOCAL_MODEL: model });
      const io = ioForModel("first");
      const before = await io.readConfigFileSnapshot();
      const staged = materializeUtilityModelSeparation(
        before.sourceConfig,
        before.sourceConfigBeforeMigrations,
      );
      await io.writeConfigFile({ ...staged.config, gateway: { mode: "local", port: 19097 } });
      const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(persisted.models.providers["local-fixture"].models[0].id).toBe(template);
      expect(persisted.agents.defaults.model).toBeUndefined();
      expect(persisted.meta.migrations.utilityModelSeparation).toBeUndefined();
      const after = await ioForModel("second").readConfigFileSnapshot();
      const second = template.replace("${LOCAL_MODEL}", "second");
      expect(
        resolveConfiguredModelRef({
          cfg: after.sourceConfig,
          agentId: "main",
          defaultProvider: "ordinary",
          defaultModel: "primary",
          allowManifestNormalization: false,
          allowPluginNormalization: false,
        }),
      ).toEqual({ provider: "local-fixture", model: second });
    },
  );

  it("preserves the shipped local primary through the registered Doctor migration", () => {
    const config = legacyConfig("/tmp/utility-separation-workspace");
    const original = structuredClone(config);
    expect(findLegacyConfigIssues(config)).toContainEqual(
      expect.objectContaining({ path: "agents" }),
    );
    const migrated = migrateLegacyConfig(config, { sourceConfigBeforeMigrations: config });
    expect(migrated.partiallyValid).toBeUndefined();
    expect(migrated.config?.agents?.defaults?.model).toEqual({ primary: "local-fixture/small" });
    expect(migrated.config?.agents?.defaults?.utilityModel).toBe("local-fixture/small");
    expect(migrated.config?.meta?.migrations?.utilityModelSeparation).toBe(true);
    expect(config).toEqual(original);
    expect(
      migrateLegacyConfig(migrated.config, { sourceConfigBeforeMigrations: migrated.config }),
    ).toEqual({ config: null, changes: [] });
  });
});
