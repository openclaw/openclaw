import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, type OpenClawConfig } from "../../config/config.js";
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
import { addFallbackCommand, removeFallbackCommand } from "./fallbacks-shared.js";
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

  it.each([
    { raw: "fixture/legacy", expected: "fixture/current" },
    { raw: "fixture/LEGACY", expected: "fixture/LEGACY" },
    { raw: "friendly", expected: "fixture/current" },
  ])("saves $raw using its cold provider's exact alias rules", async ({ raw, expected }) => {
    config.agents!.defaults!.models = { "fixture/legacy": { alias: "friendly" } };
    await isolated(() => modelsSetCommand(raw, runtime));
    expect(readConfig().agents?.defaults?.model).toEqual({ primary: expected });
    expect(runtime.log).toHaveBeenCalledWith(`Default model: ${expected}`);
  });

  it.each([
    { provider: "fixture", api: "openai-completions" },
    { provider: "custom", api: "openai-completions" },
  ] as const)("keeps the $provider/$api owner's model literal", async ({ provider, api }) => {
    config.models = {
      providers: {
        [provider]: {
          api,
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
    await isolated(() => modelsSetCommand(`${provider}/legacy`, runtime));
    expect(readConfig().agents?.defaults?.model).toEqual({ primary: `${provider}/legacy` });
  });

  it("uses the same canonical target for alias and fallback mutations", async () => {
    await isolated(async () => {
      await modelsAliasesAddCommand("friendly", "fixture/legacy", runtime);
      expect(readConfig().agents?.defaults?.models?.["fixture/current"]?.alias).toBe("friendly");
      await addFallbackCommand({ label: "Fallbacks", key: "model" }, "friendly", runtime);
      expect(readConfig().agents?.defaults?.model).toEqual({ fallbacks: ["fixture/current"] });
      await removeFallbackCommand(
        { label: "Fallbacks", key: "model", notFoundLabel: "Fallback" },
        "fixture/legacy",
        runtime,
      );
      expect(readConfig().agents?.defaults?.model).toEqual({ fallbacks: [] });
    });
  });

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

  it("keeps retained and empty generations authoritative during exact preparation", async () => {
    const marker = path.join(root, "registrations");
    const pluginFile = path.join(root, "provider", "index.cjs");
    fs.writeFileSync(
      pluginFile,
      fs
        .readFileSync(pluginFile, "utf8")
        .replace(
          "register(api) {",
          `register(api) { require("node:fs").appendFileSync(${JSON.stringify(marker)}, "registered\\n");`,
        ),
    );
    await isolated(async () => {
      const metadataSnapshot = loadManifestMetadataSnapshot({ config, env: process.env });
      const registry = loadOpenClawPlugins({ config, activate: false, env: process.env });
      const resolve = () =>
        resolvePluginProviderRegistryCore({
          config,
          providerRefs: ["fixture"],
          registryScope: "exact",
        });
      withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, () => {
        expect(resolve()?.registry).toBe(registry);
      });
      withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
        expect(resolve()?.registry.providers).toEqual([]);
      });
      expect(fs.readFileSync(marker, "utf8")).toBe("registered\n");
    });
  });

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
      await addFallbackCommand({ label: "Fallbacks", key: "model" }, "sonnet", runtime);
      expect(readConfig().agents?.defaults?.model).toEqual({
        primary: canonical,
        fallbacks: [canonical],
      });
      await removeFallbackCommand(
        { label: "Fallbacks", key: "model", notFoundLabel: "Fallback" },
        "sonnet",
        runtime,
      );
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: canonical, fallbacks: [] });
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("compares expanded fallbacks while preserving their source placeholders", async () => {
    config.agents!.defaults!.model = { fallbacks: ["${FALLBACK_REF}"] };
    await withEnvAsync({ FALLBACK_REF: "fixture/legacy" }, () =>
      isolated(async () => {
        await addFallbackCommand({ label: "Fallbacks", key: "model" }, "fixture/current", runtime);
        expect(readConfig().agents?.defaults?.model).toEqual({ fallbacks: ["${FALLBACK_REF}"] });
        await removeFallbackCommand(
          { label: "Fallbacks", key: "model", notFoundLabel: "Fallback" },
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
        removeFallbackCommand(
          { label: "Fallbacks", key: "model", notFoundLabel: "Fallback" },
          "/invalid",
          runtime,
        ),
      ).rejects.toThrow("Invalid model reference: /invalid");
    });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
