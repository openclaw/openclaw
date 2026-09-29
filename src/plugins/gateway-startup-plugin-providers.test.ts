import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayPlugins } from "../gateway/server-plugins.js";
import { collectConfiguredAgentModelProviderIds } from "./gateway-startup-plugin-providers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";
import { disposePluginRegistryInstances, resetPluginRuntimeStateForTest } from "./runtime.js";

function createManifestRecord(
  plugin: Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/plugins/${plugin.id}`,
    source: `/tmp/plugins/${plugin.id}/index.ts`,
    manifestPath: `/tmp/plugins/${plugin.id}/openclaw.plugin.json`,
    ...plugin,
  };
}

function createManifestRegistry(
  plugins: Array<Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>>,
): PluginManifestRegistry {
  return { plugins: plugins.map(createManifestRecord), diagnostics: [] };
}

describe("configured Gateway model provider ownership", () => {
  it("does not inspect model catalogs when no agent model refs are configured", () => {
    const registry = createManifestRegistry([
      {
        id: "unused",
        providers: ["unused"],
        modelCatalog: {
          providers: {
            unused: {
              get models(): never {
                throw new Error("unconfigured catalog was inspected");
              },
            },
          },
        },
      },
    ]);

    expect(collectConfiguredAgentModelProviderIds({}, registry)).toEqual(new Set());
  });

  it("does not normalize unrelated rows in a large catalog", () => {
    let unrelatedNormalizationReads = 0;
    const unrelatedModels = Array.from({ length: 10_000 }, (_, index) => ({
      id: `unrelated-${index}`,
      get name() {
        unrelatedNormalizationReads += 1;
        return `Unrelated ${index}`;
      },
    }));
    const registry = createManifestRegistry([
      {
        id: "selected",
        providers: ["selected"],
        modelCatalog: {
          providers: {
            selected: {
              api: "bedrock-converse-stream",
              models: [{ id: "requested" }, ...unrelatedModels],
            },
          },
        },
      },
      {
        id: "unrelated",
        providers: ["unrelated"],
        modelCatalog: {
          providers: {
            unrelated: { models: unrelatedModels },
          },
        },
      },
    ]);
    const config = {
      agents: { defaults: { model: "selected/requested" } },
    } as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(new Set(["selected"]));
    expect(unrelatedNormalizationReads).toBe(0);
  });
});

describe("selected CLI backend Gateway startup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it.each([
    { name: "provider API hint", apiLocation: "provider", backendOnly: false, fallback: false },
    { name: "model API hint", apiLocation: "model", backendOnly: false, fallback: false },
    { name: "backend-only fallback", apiLocation: "provider", backendOnly: true, fallback: true },
  ])("loadGatewayPlugins registers the executable with a $name", async (scenario) => {
    const root = tempDirs.make("openclaw-cli-startup-");
    const workspaceDir = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    mkdirSync(workspaceDir);
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");

    const owners = [
      {
        id: "selected-plugin",
        providers: scenario.backendOnly ? [] : ["selected-cli"],
        cliBackends: ["selected-cli"],
      },
      { id: "disabled-plugin", providers: ["disabled-cli"], cliBackends: ["disabled-cli"] },
      { id: "unused-plugin", providers: ["unused-cli"], cliBackends: ["unused-cli"] },
      { id: "http-plugin", providers: ["ordinary-http"], cliBackends: [] },
    ];
    const backendConfig = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('CLI_STARTUP_OK')"],
      input: "stdin",
      output: "text",
      sessionMode: "none",
    };
    const pluginPaths = owners.map((owner) => {
      const dir = path.join(root, owner.id);
      mkdirSync(dir);
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: owner.id,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      writeFileSync(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify({
          ...owner,
          activation: { onStartup: false },
          configSchema: { type: "object", additionalProperties: false },
        }),
      );
      writeFileSync(
        path.join(dir, "index.cjs"),
        owner.id === "selected-plugin"
          ? `module.exports = { id: "selected-plugin", register(api) {
              api.registerCliBackend({ id: "selected-cli", config: ${JSON.stringify(backendConfig)} });
            } };`
          : `throw new Error("Unexpected startup runtime: ${owner.id}");`,
      );
      return dir;
    });
    const model = {
      id: "auto",
      name: "Auto",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    };
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: scenario.fallback
            ? { primary: "ordinary-http/auto", fallbacks: ["selected-cli/auto"] }
            : { primary: "selected-cli/auto", fallbacks: ["ordinary-http/auto"] },
        },
        entries: { disabled: { model: "disabled-cli/auto" } },
      },
      models: {
        providers: {
          "selected-cli": {
            baseUrl: "cli://selected",
            ...(scenario.apiLocation === "provider" ? { api: "openai-completions" as const } : {}),
            models: [
              {
                ...model,
                ...(scenario.apiLocation === "model" ? { api: "openai-completions" as const } : {}),
              },
            ],
          },
          "disabled-cli": {
            baseUrl: "cli://disabled",
            api: "openai-completions",
            models: [model],
          },
          "ordinary-http": {
            baseUrl: "https://provider.invalid/v1",
            api: "openai-completions",
            models: [model],
          },
        },
      },
      plugins: {
        allow: owners.map((owner) => owner.id),
        load: { paths: pluginPaths },
        entries: {
          "selected-plugin": { enabled: true },
          "disabled-plugin": { enabled: false },
          "unused-plugin": { enabled: true },
          "http-plugin": { enabled: true },
        },
        slots: { memory: "none" },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));

    const loaded = loadGatewayPlugins({
      cfg: config,
      autoEnabledReasons: {},
      workspaceDir,
      baseMethods: [],
      loadIntent: "startup",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    try {
      expect(loaded.pluginRegistry.diagnostics.filter((entry) => entry.level === "error")).toEqual(
        [],
      );
      expect(
        loaded.pluginRegistry.plugins
          .filter((plugin) => plugin.status === "loaded")
          .map((plugin) => plugin.id),
      ).toEqual(["selected-plugin"]);
      expect(
        loaded.pluginRegistry.cliBackends.map(({ pluginId, backend }) => ({
          pluginId,
          id: backend.id,
          config: backend.config,
        })),
      ).toEqual([{ pluginId: "selected-plugin", id: "selected-cli", config: backendConfig }]);
    } finally {
      loaded.retireGatewayRuntimeBindings();
      await disposePluginRegistryInstances(loaded.pluginRegistry);
    }
  });
});
