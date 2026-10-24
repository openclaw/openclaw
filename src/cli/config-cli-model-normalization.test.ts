import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import {
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshotAsync,
} from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  normalizeConfigMutationModelRefs,
  shouldNormalizeConfigMutationProviderCatalogs,
} from "./config-cli-model-normalization.js";

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshotAsync: vi.fn(),
}));

vi.mock("../plugins/bundled-discovery-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/bundled-discovery-state.js")>()),
  prepareBundledDiscoveryMode: vi.fn(),
}));

const metadata = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "custom-provider",
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "stable" }, prefixWhenBare: "vendor" } },
      },
    },
  ],
});
const modelFixture = (id: string): ModelDefinitionConfig => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096,
});
const catalogConfig = (id = " latest "): OpenClawConfig => ({
  models: {
    providers: {
      custom: {
        baseUrl: "https://example.test/v1",
        models: [modelFixture(id), modelFixture("other")],
      },
    },
  },
});
function expectNoDiscovery() {
  expect(resolvePluginMetadataSnapshotAsync).not.toHaveBeenCalled();
  expect(prepareBundledDiscoveryMode).not.toHaveBeenCalled();
}
function catalogNeedsNormalization(after: OpenClawConfig, path?: string) {
  return shouldNormalizeConfigMutationProviderCatalogs({
    before: catalogConfig(),
    after,
    touchedPaths: path ? [path.split(".")] : [],
    env: {
      HOME: "/isolated-home",
      OPENCLAW_STATE_DIR: "/isolated-state",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
}
function agentModelFields(ref: string) {
  const selection = { primary: ref, fallbacks: [ref] };
  return {
    model: selection,
    imageModel: selection,
    voiceModel: selection,
    pdfModel: selection,
    utilityModel: ref,
    mediaModels: { image: selection, video: selection, music: selection },
    heartbeat: { model: ref },
    subagents: { model: selection },
    compaction: { model: ref, memoryFlush: { model: ref } },
    models: { [ref]: { alias: "test" } },
  };
}

describe("config mutation model normalization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadPluginMetadataSnapshot).mockImplementation(() => {
      throw new Error("Config normalization must prepare metadata asynchronously");
    });
    vi.mocked(resolvePluginMetadataSnapshotAsync).mockResolvedValue(metadata);
    vi.mocked(prepareBundledDiscoveryMode).mockResolvedValue(() => {});
    vi.mocked(isPluginMetadataSnapshotCompatible).mockReturnValue(true);
  });
  afterEach(() => expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled());

  it("keeps core-only mutations independent from plugin discovery", async () => {
    expect(await normalizeConfigMutationModelRefs({ gateway: { mode: "local" } })).toEqual({
      gateway: { mode: "local" },
    });
    expect(
      await normalizeConfigMutationModelRefs({
        models: { providers: { custom: { baseUrl: "https://example.test", models: [] } } },
      }),
    ).toBeDefined();
    expectNoDiscovery();
  });

  it("leaves an untouched provider catalog alone while normalizing core agent refs", async () => {
    const config = {
      ...catalogConfig(),
      agents: { defaults: { model: " openai/example " } },
    };
    const result = await normalizeConfigMutationModelRefs(config, {
      normalizeProviderCatalogs: false,
    });
    expect(result.models).toBe(config.models);
    expect(result.agents?.defaults?.model).toBe("openai/example");
    expectNoDiscovery();
  });

  it.each<[string, OpenClawConfig, boolean]>([
    ["gateway.mode", { gateway: { mode: "local" } }, false],
    ["agents.defaults.model", { agents: { defaults: { model: "openai/example" } } }, false],
    ["agents.defaults.workspace", { agents: { defaults: { workspace: "/new-workspace" } } }, false],
    ["models.providers.custom.models", {}, true],
    ["models", {}, true],
    ["plugins.load.paths", { plugins: { load: { paths: ["/new-plugin-root"] } } }, true],
    [
      "plugins.entries.custom.enabled",
      { plugins: { entries: { custom: { enabled: false } } } },
      true,
    ],
    ["channels.telegram.enabled", { channels: { telegram: { enabled: true } } }, true],
  ])("selects catalog normalization for %s", (path, patch, expected) => {
    expect(catalogNeedsNormalization({ ...catalogConfig(), ...patch }, path)).toBe(expected);
  });

  it("normalizes catalog values changed indirectly by a parent operation", () => {
    expect(catalogNeedsNormalization(catalogConfig("changed"))).toBe(true);
  });

  it.each(["defaults", "entries", "list"] as const)("normalizes %s model fields", async (scope) => {
    const model = "together/meta-llama/Llama-3.3-70B-Instruct-Turbo";
    const wrap = (value: unknown) => ({
      agents: {
        [scope]: scope === "defaults" ? value : scope === "list" ? [value] : { a: value },
      },
    });
    expect(
      await normalizeConfigMutationModelRefs(
        wrap(agentModelFields(` ${model} `)) as OpenClawConfig,
      ),
    ).toEqual(wrap(agentModelFields(model)));
  });

  it.each([false, true])("applies policies with prepared=%s", async (prepared) => {
    const config = catalogConfig();
    const result = await normalizeConfigMutationModelRefs(
      config,
      prepared ? { pluginMetadataSnapshot: metadata } : undefined,
    );
    expect(result.models?.providers?.custom?.models.map((model) => model.id)).toEqual([
      "vendor/stable",
      "vendor/other",
    ]);
    expect(resolvePluginMetadataSnapshotAsync).toHaveBeenCalledTimes(prepared ? 0 : 1);
  });

  it.each(["single", "merged"] as const)("excludes %s workspace metadata", async (scope) => {
    const scopedMetadata = {
      ...metadata,
      index: {
        ...metadata.index,
        ...(scope === "single" ? { workspaceDir: "/workspace/old" } : {}),
        plugins: metadata.index.plugins.map((plugin) => ({
          ...plugin,
          origin: "workspace" as const,
        })),
      },
    };
    const config = { ...catalogConfig(), agents: { defaults: { workspace: "/workspace/new" } } };
    await normalizeConfigMutationModelRefs(config, {
      pluginMetadataSnapshot: scopedMetadata,
    });
    expect(resolvePluginMetadataSnapshotAsync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolvePluginMetadataSnapshotAsync).mock.calls[0]?.[0].config).toBe(config);
  });

  it("reloads policies when plugin discovery inputs change", async () => {
    vi.mocked(isPluginMetadataSnapshotCompatible).mockReturnValue(false);
    const config = { ...catalogConfig(), plugins: { load: { paths: ["/new-plugin-root"] } } };
    const env = { OPENCLAW_STATE_DIR: "/isolated-state" };
    await normalizeConfigMutationModelRefs(config, {
      pluginMetadataSnapshot: metadata,
      env,
    });
    expect(resolvePluginMetadataSnapshotAsync).toHaveBeenCalledTimes(1);
    const [loaded] = vi.mocked(resolvePluginMetadataSnapshotAsync).mock.calls;
    expect(loaded?.[0].config).toBe(config);
    expect(loaded?.[0].env).toBe(env);
  });
});
