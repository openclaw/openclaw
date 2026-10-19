import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readConfigFileSnapshot,
  resetConfigRuntimeState,
  type OpenClawConfig,
} from "../../config/config.js";
import { DEFAULT_MODEL_ALIASES } from "../../config/defaults.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import {
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginProviderRegistryCore } from "../../plugins/providers.runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { modelsAliasesAddCommand } from "./aliases.js";
import { changeFallbacksCommand } from "./fallbacks-shared.js";
import { modelsSetCommand } from "./set.js";

describe("model command provider preparation", () => {
  let root: string;
  let configPath: string;
  let config: OpenClawConfig;
  let runtime: RuntimeEnv;

  const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  const defaults = () => readConfig().agents?.defaults;
  const alias = (name: string, model: string) => modelsAliasesAddCommand(name, model, runtime);
  const setModel = (model: string, field?: "imageModel") => modelsSetCommand(model, runtime, field);
  function fallback(
    action: "add" | "remove",
    model: string,
    key: "model" | "imageModel" = "model",
  ) {
    const params = { label: "Fallbacks", key };
    return changeFallbacksCommand(
      action === "add" ? { ...params, action } : { ...params, action, notFoundLabel: "Fallback" },
      model,
      runtime,
    );
  }
  function manifest(dir: string, id: string, providers: string[]) {
    writeJson(path.join(dir, "openclaw.plugin.json"), {
      id,
      providers,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    });
  }
  function patchProvider(edit: (source: string) => string) {
    const file = path.join(root, "alias-fixture/index.cjs");
    fs.writeFileSync(file, edit(fs.readFileSync(file, "utf8")));
  }
  function plugin(id: string, providers: [string, ...string[]], definition: string, prelude = "") {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    manifest(dir, id, providers);
    fs.writeFileSync(
      path.join(dir, "index.cjs"),
      `${prelude}
      module.exports = { id: ${JSON.stringify(id)}, register(api) {
        api.registerProvider({ id: ${JSON.stringify(providers[0])}, label: "Fixture", auth: [], ${definition} });
      }};`,
    );
    return dir;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-command-"));
    configPath = path.join(root, "openclaw.json");
    const pluginDir = plugin(
      "alias-fixture",
      ["fixture", "custom"],
      'hookAliases: ["custom"], normalizeModelId: ({ modelId }) => modelId === "legacy" ? "current" : undefined',
    );
    config = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "probe" } },
        entries: { probe: {} },
      },
      plugins: { allow: ["alias-fixture"], load: { paths: [pluginDir] } },
    };
    runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  });

  afterEach(async () => {
    resetConfigRuntimeState();
    resetPluginLoaderTestStateForTest();
    clearPluginMetadataLifecycleCaches();
    await cleanupSessionStateForTest({ stateDir: root });
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function isolated(run: () => Promise<void>, env: NodeJS.ProcessEnv = {}) {
    writeJson(configPath, config);
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        ...env,
      },
      run,
    );
  }

  function readConfig(): OpenClawConfig {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  it("rejects unknown alias providers without changing config", async () => {
    await isolated(async () => {
      const before = fs.readFileSync(configPath, "utf8");
      await expect(alias("local", "ollmaa/qwen3:4b")).rejects.toThrow(
        'Unknown model provider "ollmaa"',
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    });
  });

  it("preserves literal models owned by an explicit API route", async () => {
    config.models = {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://custom.example.invalid/v1",
          models: [],
        },
      },
    };
    config.agents!.defaults!.models = {
      "fixture/legacy": { alias: "friendly", params: { temperature: 0.2 } },
    };
    await isolated(async () => {
      await setModel("fixture/legacy");
      await alias("Friendly", "fixture/legacy");
      await alias("Friendly", "fixture/legacy");
      await expect(alias("friendly", "fixture/current")).rejects.toThrow(
        "Alias friendly already points to fixture/legacy.",
      );
    });
    expect(defaults()?.model).toEqual({ primary: "fixture/legacy" });
    expect(defaults()?.models).toEqual({
      "fixture/legacy": { alias: "Friendly", params: { temperature: 0.2 } },
    });
  });

  it("preserves alias settings and includes across canonical moves", async () => {
    const preserved = {
      maxTokens: 128,
      cacheRetention: "${ALIAS_CACHE_RETENTION}",
      credential: { source: "env", provider: "default", id: "MODEL_SECRET" },
    };
    config.agents!.defaults!.models = {
      "fixture/legacy": {
        alias: "${MODEL_ALIAS}",
        params: { temperature: 0.2, ...preserved },
        streaming: false,
      },
      "fixture/current": { params: { temperature: 0.7 }, codeMode: false },
      "unrelated/legacy": {
        alias: "other",
        params: { temperature: 0.9, cacheRetention: "long" },
      },
    };
    await isolated(
      async () => {
        const agentsPath = path.join(root, "agents.json");
        writeJson(agentsPath, config.agents);
        writeJson(configPath, { ...config, agents: { $include: "agents.json" } });
        const readAgents = (): OpenClawConfig["agents"] =>
          JSON.parse(fs.readFileSync(agentsPath, "utf8"));
        await alias("friendly", "fixture/legacy");
        const expectedModels = {
          "fixture/current": {
            alias: "friendly",
            params: { temperature: 0.7, ...preserved },
            streaming: false,
            codeMode: false,
          },
          "unrelated/legacy": config.agents!.defaults!.models!["unrelated/legacy"],
        };
        expect(readAgents()?.defaults?.models).toEqual(expectedModels);
        await alias("friendly", "fixture/legacy");
        expect(readAgents()?.defaults?.models).toEqual(expectedModels);
        await expect(alias("FRIENDLY", "fixture/different")).rejects.toThrow(
          "Alias FRIENDLY already points to fixture/current.",
        );
        expect(readAgents()?.defaults?.models).toEqual(expectedModels);
        await fallback("add", "friendly");
        expect((await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model).toEqual({
          fallbacks: ["fixture/current"],
        });
        await fallback("remove", "fixture/legacy");
        expect((await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model).toEqual({
          fallbacks: [],
        });
        expect(readConfig().agents).toMatchObject({ $include: "agents.json" });
      },
      { MODEL_ALIAS: "friendly", ALIAS_CACHE_RETENTION: "long" },
    );
  });

  it.each([false, true])(
    "preserves nested includes (sibling overrides: %s)",
    async (siblingOverrides) => {
      const models = {
        "fixture/legacy": {
          alias: "friendly",
          params: { cacheRetention: "${ALIAS_CACHE_RETENTION}" },
        },
      };
      config.agents!.defaults!.models = models;
      await isolated(
        async () => {
          const modelsPath = path.join(root, "models.json");
          const modelsRaw = JSON.stringify(models);
          const rootRaw = JSON.stringify({
            ...config,
            agents: {
              ...config.agents,
              defaults: {
                ...config.agents?.defaults,
                models: {
                  $include: "models.json",
                  ...(siblingOverrides ? { "fixture/other": { alias: "other" } } : {}),
                },
              },
            },
          });
          fs.writeFileSync(modelsPath, modelsRaw);
          fs.writeFileSync(configPath, rootRaw);
          if (siblingOverrides) {
            await expect(alias("friendly", "fixture/legacy")).rejects.toThrow("$include");
            expect(fs.readFileSync(modelsPath, "utf8")).toBe(modelsRaw);
          } else {
            await alias("friendly", "fixture/legacy");
            expect(JSON.parse(fs.readFileSync(modelsPath, "utf8"))).toEqual({
              "fixture/current": models["fixture/legacy"],
            });
          }
          expect(fs.readFileSync(configPath, "utf8")).toBe(rootRaw);
        },
        { ALIAS_CACHE_RETENTION: "long" },
      );
    },
  );

  it("ignores foreign hooks in an existing registry", async () => {
    const foreignDir = plugin(
      "aaa-foreign",
      ["foreign"],
      'hookAliases: ["fixture"], normalizeModelId: () => "wrong-owner"',
    );
    config.plugins!.allow!.unshift("aaa-foreign");
    config.plugins!.load!.paths!.unshift(foreignDir);
    config.agents!.entries!.probe = { workspace: root };
    await isolated(async () => {
      const registry = loadOpenClawPlugins({ config, workspaceDir: root, env: process.env });
      expect(registry.providers.map((entry) => entry.pluginId)).toEqual([
        "aaa-foreign",
        "alias-fixture",
      ]);
      await setModel("fixture/legacy");
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: "fixture/current" });
    });
  });

  it.each(["exact", "retained", "empty"] as const)(
    "preserves source refs in %s runtime scope",
    async (scope) => {
      const marker = path.join(root, "registrations");
      patchProvider((source) =>
        source
          .replace(
            "register(api) {",
            `register(api) {
              const fs = require("node:fs");
              const model = fs.existsSync(${JSON.stringify(marker)}) ? "current" : "stale";
              fs.appendFileSync(${JSON.stringify(marker)}, "registered\\n");`,
          )
          .replace('hookAliases: ["custom"]', 'hookAliases: ["compat"]')
          .replace('? "current" : undefined', "? model : undefined"),
      );
      const entry = { params: { cacheRetention: "${ALIAS_CACHE_RETENTION}" }, streaming: false };
      config.agents!.defaults!.models = { "compat/legacy": entry };
      config.agents!.entries!.probe = { workspace: root };
      await isolated(
        async () => {
          const context = { config, env: process.env, workspaceDir: root };
          const metadataSnapshot = loadManifestMetadataSnapshot(context);
          const registry = loadOpenClawPlugins(context);
          expect(
            resolvePluginProviderRegistryCore({
              ...context,
              providerRefs: ["compat"],
            })?.registry,
          ).toBe(registry);
          expect(fs.readFileSync(marker, "utf8")).toBe("registered\n");
          const run = async () => {
            await alias("friendly", "compat/legacy");
            await setModel("friendly");
            await setModel("friendly", "imageModel");
            for (const key of ["model", "imageModel"] as const) {
              await fallback("add", "friendly", key);
            }
          };
          if (scope === "exact") {
            await run();
          } else {
            await withPluginRuntimeGenerationScope(
              { metadataSnapshot, ...(scope === "retained" ? { pluginRegistry: registry } : {}) },
              run,
            );
          }
          const model = scope === "exact" ? "current" : scope === "retained" ? "stale" : "legacy";
          expect(readConfig().agents?.defaults?.models).toEqual({
            [`compat/${model}`]: { ...entry, alias: "friendly" },
          });
          expect(runtime.log).toHaveBeenCalledWith(`Alias friendly -> compat/${model}`);
          for (const key of ["model", "imageModel"] as const) {
            expect(readConfig().agents?.defaults?.[key]).toEqual({
              primary: `compat/${model}`,
              fallbacks: [`compat/${model}`],
            });
          }
          if (scope === "empty") {
            const errors = vi.mocked(runtime.error).mock.calls;
            expect(
              errors.filter(([msg]) => String(msg).includes("could not be verified")),
            ).toHaveLength(5);
          }
          expect(fs.readFileSync(marker, "utf8")).toBe(
            "registered\n".repeat(scope === "exact" ? 2 : 1),
          );
        },
        { ALIAS_CACHE_RETENTION: "long" },
      );
    },
  );

  it("does not activate unused providers for aliases", async () => {
    const canonical = DEFAULT_MODEL_ALIASES.sonnet;
    assert(canonical, "Expected the built-in sonnet alias");
    config.agents!.defaults!.models = { [canonical]: {} };
    const providerDir = path.join(root, "alias-fixture");
    manifest(providerDir, "alias-fixture", ["anthropic"]);
    patchProvider((source) => source.replace('id: "fixture", label:', 'id: "anthropic", label:'));
    const marker = path.join(root, "unused-imported");
    const unusedDir = plugin(
      "unused-provider",
      ["openai"],
      "",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");`,
    );
    config.plugins!.allow!.push("unused-provider");
    config.plugins!.load!.paths!.push(unusedDir);

    await isolated(async () => {
      await setModel("sonnet");
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: canonical });
      await fallback("add", "sonnet");
      expect(readConfig().agents?.defaults?.model).toEqual({
        primary: canonical,
        fallbacks: [canonical],
      });
      await fallback("remove", "sonnet");
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: canonical, fallbacks: [] });
      await alias("friendly", "sonnet");
      await alias("friendly", canonical);
      expect(readConfig().agents?.defaults?.models?.[canonical]?.alias).toBe("friendly");
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("repairs entries without rewriting fallback placeholders", async () => {
    config.agents!.defaults!.model = { fallbacks: ["${FALLBACK_REF}"] };
    const entry = { params: { temperature: 0.2 }, streaming: false };
    config.agents!.defaults!.models = { "fixture/legacy": entry };
    await isolated(
      async () => {
        await fallback("add", "fixture/current");
        expect(readConfig().agents?.defaults?.model).toEqual({ fallbacks: ["${FALLBACK_REF}"] });
        expect(readConfig().agents?.defaults?.models).toEqual({ "fixture/current": entry });
        await fallback("remove", "fixture/current");
        expect(readConfig().agents?.defaults?.model).toEqual({ fallbacks: [] });
      },
      { FALLBACK_REF: "fixture/legacy" },
    );
  });

  it("rejects config replacement during provider preparation", async () => {
    patchProvider((source) =>
      source.replace(
        "register(api) {",
        `register(api) {
          const fs = require("node:fs");
          const file = ${JSON.stringify(configPath)};
          const newer = JSON.parse(fs.readFileSync(file, "utf8"));
          newer.update = { channel: "beta" };
          fs.writeFileSync(file, JSON.stringify(newer));`,
      ),
    );
    await isolated(async () => {
      await expect(setModel("fixture/legacy")).rejects.toBeInstanceOf(ConfigMutationConflictError);
    });
    expect(readConfig().update?.channel).toBe("beta");
    expect(readConfig().agents?.defaults?.model).toBeUndefined();
  });

  it("rejects an invalid fallback target before activating existing providers", async () => {
    config.agents!.defaults!.model = { fallbacks: ["fixture/legacy"] };
    const marker = path.join(root, "provider-imported");
    patchProvider(
      (source) =>
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");\n${source}`,
    );
    await isolated(async () => {
      await expect(fallback("remove", "/invalid")).rejects.toThrow(
        "Invalid model reference: /invalid",
      );
    });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
