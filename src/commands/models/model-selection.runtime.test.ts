import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-command-"));
    configPath = path.join(root, "openclaw.json");
    const pluginDir = path.join(root, "provider");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "alias-fixture",
        providers: ["fixture", "custom"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
        id: "alias-fixture",
        register(api) {
          api.registerProvider({
            id: "fixture", label: "Fixture", hookAliases: ["custom"], auth: [],
            normalizeModelId: ({ modelId }) => modelId === "legacy" ? "current" : undefined,
          });
        },
      };`,
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

  async function isolated(run: () => Promise<void>) {
    fs.writeFileSync(configPath, JSON.stringify(config));
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      },
      run,
    );
  }

  function readConfig(): OpenClawConfig {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  it("rejects unknown providers for alias without changing config bytes", async () => {
    await isolated(async () => {
      const before = fs.readFileSync(configPath, "utf8");
      await expect(modelsAliasesAddCommand("local", "ollmaa/qwen3:4b", runtime)).rejects.toThrow(
        'Unknown model provider "ollmaa"',
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    });
  });

  it("keeps the fixture/openai-completions owner's model literal", async () => {
    config.models = {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://custom.example.invalid/v1",
          models: [
            {
              id: "legacy",
              name: "Literal model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1024,
            },
          ],
        },
      },
    };
    config.agents!.defaults!.models = {
      "fixture/legacy": { alias: "friendly", params: { temperature: 0.2 } },
    };
    await isolated(async () => {
      await modelsSetCommand("fixture/legacy", runtime);
      await modelsAliasesAddCommand("Friendly", "fixture/legacy", runtime);
      await modelsAliasesAddCommand("Friendly", "fixture/legacy", runtime);
      await expect(modelsAliasesAddCommand("friendly", "fixture/current", runtime)).rejects.toThrow(
        "Alias friendly already points to fixture/legacy.",
      );
    });
    expect(readConfig().agents?.defaults?.model).toEqual({ primary: "fixture/legacy" });
    expect(readConfig().agents?.defaults?.models).toEqual({
      "fixture/legacy": { alias: "Friendly", params: { temperature: 0.2 } },
    });
  });

  it("preserves alias source settings across canonical moves (existing: true, include: true, alias: same)", async () => {
    config.agents!.defaults!.models = {
      "fixture/legacy": {
        alias: "${MODEL_ALIAS}",
        params: {
          temperature: 0.2,
          maxTokens: 128,
          cacheRetention: "${ALIAS_CACHE_RETENTION}",
          credential: { source: "env", provider: "default", id: "MODEL_SECRET" },
        },
        streaming: false,
      },
      "fixture/current": { params: { temperature: 0.7 }, codeMode: false },
      "unrelated/legacy": {
        alias: "other",
        params: { temperature: 0.9, cacheRetention: "long" },
      },
    };
    await withEnvAsync({ MODEL_ALIAS: "friendly", ALIAS_CACHE_RETENTION: "long" }, () =>
      isolated(async () => {
        const agentsPath = path.join(root, "agents.json");
        fs.writeFileSync(agentsPath, JSON.stringify(config.agents));
        fs.writeFileSync(
          configPath,
          JSON.stringify({ ...config, agents: { $include: "agents.json" } }),
        );
        const readAgents = (): OpenClawConfig["agents"] =>
          JSON.parse(fs.readFileSync(agentsPath, "utf8"));
        await modelsAliasesAddCommand("friendly", "fixture/legacy", runtime);
        const expectedModels = {
          "fixture/current": {
            alias: "friendly",
            params: {
              temperature: 0.7,
              maxTokens: 128,
              cacheRetention: "${ALIAS_CACHE_RETENTION}",
              credential: { source: "env", provider: "default", id: "MODEL_SECRET" },
            },
            streaming: false,
            codeMode: false,
          },
          "unrelated/legacy": {
            alias: "other",
            params: { temperature: 0.9, cacheRetention: "long" },
          },
        };
        expect(readAgents()?.defaults?.models).toEqual(expectedModels);
        await modelsAliasesAddCommand("friendly", "fixture/legacy", runtime);
        expect(readAgents()?.defaults?.models).toEqual(expectedModels);
        await expect(
          modelsAliasesAddCommand("FRIENDLY", "fixture/different", runtime),
        ).rejects.toThrow("Alias FRIENDLY already points to fixture/current.");
        expect(readAgents()?.defaults?.models).toEqual(expectedModels);
        await changeFallbacksCommand(
          { label: "Fallbacks", key: "model", action: "add" },
          "friendly",
          runtime,
        );
        expect((await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model).toEqual({
          fallbacks: ["fixture/current"],
        });
        await changeFallbacksCommand(
          { label: "Fallbacks", key: "model", notFoundLabel: "Fallback", action: "remove" },
          "fixture/legacy",
          runtime,
        );
        expect((await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model).toEqual({
          fallbacks: [],
        });
        expect(readConfig().agents).toMatchObject({ $include: "agents.json" });
      }),
    );
  });

  it.each([false, true])(
    "preserves nested include ownership with sibling overrides=%s",
    async (siblingOverrides) => {
      const models = {
        "fixture/legacy": {
          alias: "friendly",
          params: { cacheRetention: "${ALIAS_CACHE_RETENTION}" },
        },
      };
      config.agents!.defaults!.models = models;
      await withEnvAsync({ ALIAS_CACHE_RETENTION: "long" }, () =>
        isolated(async () => {
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
            await expect(
              modelsAliasesAddCommand("friendly", "fixture/legacy", runtime),
            ).rejects.toThrow("$include");
            expect(fs.readFileSync(modelsPath, "utf8")).toBe(modelsRaw);
          } else {
            await modelsAliasesAddCommand("friendly", "fixture/legacy", runtime);
            expect(JSON.parse(fs.readFileSync(modelsPath, "utf8"))).toEqual({
              "fixture/current": models["fixture/legacy"],
            });
          }
          expect(fs.readFileSync(configPath, "utf8")).toBe(rootRaw);
        }),
      );
    },
  );

  it("excludes unrelated hooks when reusing an already-loaded registry", async () => {
    const foreignDir = path.join(root, "aaa-foreign");
    fs.mkdirSync(foreignDir);
    fs.writeFileSync(
      path.join(foreignDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "aaa-foreign",
        providers: ["foreign"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(foreignDir, "index.cjs"),
      `module.exports = { id: "aaa-foreign", register(api) {
        api.registerProvider({ id: "foreign", label: "Foreign", auth: [],
          hookAliases: ["fixture"], normalizeModelId: () => "wrong-owner" });
      }};`,
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
      await modelsSetCommand("fixture/legacy", runtime);
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: "fixture/current" });
    });
  });

  it.each(["exact", "retained", "empty"] as const)(
    "prepares runtime-only aliases with %s ownership while preserving source refs",
    async (scope) => {
      const marker = path.join(root, "registrations");
      const pluginFile = path.join(root, "provider", "index.cjs");
      fs.writeFileSync(
        pluginFile,
        fs
          .readFileSync(pluginFile, "utf8")
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
      await withEnvAsync({ ALIAS_CACHE_RETENTION: "long" }, () =>
        isolated(async () => {
          const metadataSnapshot = loadManifestMetadataSnapshot({
            config,
            env: process.env,
            workspaceDir: root,
          });
          const registry = loadOpenClawPlugins({ config, env: process.env, workspaceDir: root });
          expect(
            resolvePluginProviderRegistryCore({
              config,
              workspaceDir: root,
              providerRefs: ["compat"],
            })?.registry,
          ).toBe(registry);
          expect(fs.readFileSync(marker, "utf8")).toBe("registered\n");
          const run = async () => {
            await modelsAliasesAddCommand("friendly", "compat/legacy", runtime);
            await modelsSetCommand("friendly", runtime);
            await modelsSetCommand("friendly", runtime, "imageModel");
            for (const key of ["model", "imageModel"] as const) {
              await changeFallbacksCommand(
                { label: "Fallbacks", key, action: "add" },
                "friendly",
                runtime,
              );
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
            expect(
              vi
                .mocked(runtime.error)
                .mock.calls.filter(([message]) =>
                  String(message).includes("could not be verified"),
                ),
            ).toHaveLength(5);
          }
          expect(fs.readFileSync(marker, "utf8")).toBe(
            "registered\n".repeat(scope === "exact" ? 2 : 1),
          );
        }),
      );
    },
  );

  it("does not activate an unused provider for a runtime-only alias", async () => {
    const canonical = DEFAULT_MODEL_ALIASES.sonnet;
    if (!canonical) {
      throw new Error("Expected the built-in sonnet alias");
    }
    config.agents!.defaults!.models = { [canonical]: {} };
    const providerDir = path.join(root, "provider");
    fs.writeFileSync(
      path.join(providerDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "alias-fixture",
        providers: ["anthropic"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    const providerFile = path.join(providerDir, "index.cjs");
    fs.writeFileSync(
      providerFile,
      fs
        .readFileSync(providerFile, "utf8")
        .replace('id: "fixture", label:', 'id: "anthropic", label:'),
    );
    const unusedDir = path.join(root, "unused");
    const marker = path.join(root, "unused-imported");
    fs.mkdirSync(unusedDir);
    fs.writeFileSync(
      path.join(unusedDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "unused-provider",
        providers: ["openai"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(unusedDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");
      module.exports = { id: "unused-provider", register(api) {
        api.registerProvider({ id: "openai", label: "Unused", auth: [] });
      }};`,
    );
    config.plugins!.allow!.push("unused-provider");
    config.plugins!.load!.paths!.push(unusedDir);

    await isolated(async () => {
      await modelsSetCommand("sonnet", runtime);
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: canonical });
      await changeFallbacksCommand(
        { label: "Fallbacks", key: "model", action: "add" },
        "sonnet",
        runtime,
      );
      expect(readConfig().agents?.defaults?.model).toEqual({
        primary: canonical,
        fallbacks: [canonical],
      });
      await changeFallbacksCommand(
        { label: "Fallbacks", key: "model", notFoundLabel: "Fallback", action: "remove" },
        "sonnet",
        runtime,
      );
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: canonical, fallbacks: [] });
      await modelsAliasesAddCommand("friendly", "sonnet", runtime);
      await modelsAliasesAddCommand("friendly", canonical, runtime);
      expect(readConfig().agents?.defaults?.models?.[canonical]?.alias).toBe("friendly");
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("repairs model entry settings while preserving an existing fallback placeholder", async () => {
    config.agents!.defaults!.model = { fallbacks: ["${FALLBACK_REF}"] };
    const entry = { params: { temperature: 0.2 }, streaming: false };
    config.agents!.defaults!.models = { "fixture/legacy": entry };
    await withEnvAsync({ FALLBACK_REF: "fixture/legacy" }, () =>
      isolated(async () => {
        await changeFallbacksCommand(
          { label: "Fallbacks", key: "model", action: "add" },
          "fixture/current",
          runtime,
        );
        expect(readConfig().agents?.defaults?.model).toEqual({ fallbacks: ["${FALLBACK_REF}"] });
        expect(readConfig().agents?.defaults?.models).toEqual({ "fixture/current": entry });
        await changeFallbacksCommand(
          { label: "Fallbacks", key: "model", notFoundLabel: "Fallback", action: "remove" },
          "fixture/current",
          runtime,
        );
        expect(readConfig().agents?.defaults?.model).toEqual({ fallbacks: [] });
      }),
    );
  });

  it("rejects config replacement during provider preparation", async () => {
    const pluginFile = path.join(root, "provider", "index.cjs");
    fs.writeFileSync(
      pluginFile,
      fs.readFileSync(pluginFile, "utf8").replace(
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
      await expect(modelsSetCommand("fixture/legacy", runtime)).rejects.toBeInstanceOf(
        ConfigMutationConflictError,
      );
    });
    expect(readConfig().update?.channel).toBe("beta");
    expect(readConfig().agents?.defaults?.model).toBeUndefined();
  });

  it("rejects an invalid fallback target before activating existing providers", async () => {
    config.agents!.defaults!.model = { fallbacks: ["fixture/legacy"] };
    const marker = path.join(root, "provider-imported");
    const pluginFile = path.join(root, "provider", "index.cjs");
    fs.writeFileSync(
      pluginFile,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");\n` +
        fs.readFileSync(pluginFile, "utf8"),
    );
    await isolated(async () => {
      await expect(
        changeFallbacksCommand(
          { label: "Fallbacks", key: "model", notFoundLabel: "Fallback", action: "remove" },
          "/invalid",
          runtime,
        ),
      ).rejects.toThrow("Invalid model reference: /invalid");
    });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
