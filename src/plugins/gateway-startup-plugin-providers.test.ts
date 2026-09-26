import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
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
  it("admits the implicit default but not unused model picker entries or API owners", () => {
    const registry = createManifestRegistry([
      { id: "default-owner", providers: [DEFAULT_PROVIDER] },
      { id: "unused-owner", providers: ["unused"] },
    ]);
    expect(
      collectConfiguredAgentModelProviderIds(
        {
          agents: { defaults: { models: { "unused/model": { alias: "unused-alias" } } } },
        },
        registry,
      ),
    ).toEqual(new Set([DEFAULT_PROVIDER]));
    expect(
      collectConfiguredAgentModelProviderIds(
        {
          agents: { defaults: { model: "custom/model" } },
          models: {
            providers: {
              custom: { baseUrl: "https://custom.invalid", api: "openai-responses", models: [] },
            },
          },
        },
        registry,
      ),
    ).toEqual(new Set());
  });

  it("shares primary, alias, fallback and subagent chains without activating every model key", () => {
    const ids = ["primary", "fallback", "subagent", "sub-fallback", "utility", "unused"];
    const registry = createManifestRegistry(ids.map((id) => ({ id, providers: [id] })));
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "selected-alias", fallbacks: ["fallback/model"] },
          subagents: { model: { primary: "subagent/model", fallbacks: ["sub-fallback/model"] } },
          utilityModel: "utility/model",
          models: { "primary/model": { alias: "selected-alias" }, "unused/model": {} },
        },
        entries: { agent: { models: { "unused/other": { alias: "unused-agent-alias" } } } },
      },
    };
    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
      new Set(["primary", "fallback", "subagent", "sub-fallback", "utility"]),
    );
    // Per-agent empty fallbacks and utility disablement replace inherited policy.
    config.agents!.entries!.agent = {
      model: { primary: "primary/model", fallbacks: [] },
      subagents: { model: { primary: "subagent/model", fallbacks: [] } },
      utilityModel: "",
    };
    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
      new Set(["primary", "subagent"]),
    );
  });

  it.each(["small", "small@utility:work", "utility/small"])(
    "admits the explicit utility alias %s without enabling unused picker owners",
    (utilityModel) => {
      const registry = createManifestRegistry(
        ["primary", "utility", "unused"].map((id) => ({ id, providers: [id] })),
      );
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "primary/model",
            utilityModel,
            models: { "utility/model": { alias: "small" }, "unused/model": {} },
          },
        },
      };
      expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
        new Set(["primary", "utility"]),
      );
    },
  );

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
      { id: "denied-plugin", providers: ["denied"], cliBackends: [] },
      { id: "untrusted-plugin", providers: ["untrusted"], cliBackends: [] },
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
          : owner.id === "http-plugin"
            ? `module.exports = { id: "http-plugin", register(api) {
                api.registerProvider({ id: "ordinary-http", label: "HTTP provider hooks", auth: [] });
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
        entries: {
          configured: {},
          disabled: { model: "disabled-cli/auto" },
          denied: { model: "denied/auto" },
          untrusted: { model: "untrusted/auto" },
        },
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
        allow: owners.filter((owner) => owner.id !== "untrusted-plugin").map((owner) => owner.id),
        deny: ["denied-plugin"],
        load: { paths: pluginPaths },
        entries: {
          "selected-plugin": { enabled: true },
          "disabled-plugin": { enabled: false },
          "unused-plugin": { enabled: true },
          "http-plugin": { enabled: true },
          "denied-plugin": { enabled: true },
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
      ).toEqual(["selected-plugin", "http-plugin"]);
      expect(loaded.pluginRegistry.providers.map(({ provider }) => provider.id)).toEqual([
        "ordinary-http",
      ]);
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
