import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("config mutation model normalization", () => {
  beforeEach(() => {
    vi.mocked(loadPluginMetadataSnapshot)
      .mockReset()
      .mockImplementation(() => {
        throw new Error("Config normalization must prepare metadata asynchronously");
      });
    vi.mocked(resolvePluginMetadataSnapshotAsync).mockReset().mockResolvedValue(metadata);
    vi.mocked(prepareBundledDiscoveryMode)
      .mockReset()
      .mockResolvedValue(() => {});
    vi.mocked(isPluginMetadataSnapshotCompatible).mockReset().mockReturnValue(true);
  });

  it("keeps core-only mutations independent from plugin discovery", async () => {
    expect(await normalizeConfigMutationModelRefs({ gateway: { mode: "local" } })).toEqual({
      gateway: { mode: "local" },
    });
    expect(
      await normalizeConfigMutationModelRefs({
        models: { providers: { custom: { baseUrl: "https://example.test", models: [] } } },
      }),
    ).toBeDefined();
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(0);
    expect(resolvePluginMetadataSnapshotAsync).toHaveBeenCalledTimes(0);
    expect(prepareBundledDiscoveryMode).toHaveBeenCalledTimes(0);
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
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(0);
    expect(resolvePluginMetadataSnapshotAsync).toHaveBeenCalledTimes(0);
    expect(prepareBundledDiscoveryMode).toHaveBeenCalledTimes(0);
  });

  it.each([
    {
      name: "gateway mode",
      patch: { gateway: { mode: "local" } },
      path: ["gateway", "mode"],
      expected: false,
    },
    {
      name: "agent model",
      patch: { agents: { defaults: { model: "openai/example" } } },
      path: ["agents", "defaults", "model"],
      expected: false,
    },
    {
      name: "agent workspace",
      patch: { agents: { defaults: { workspace: "/new-workspace" } } },
      path: ["agents", "defaults", "workspace"],
      expected: false,
    },
    {
      name: "explicit catalog write",
      patch: {},
      path: ["models", "providers", "custom", "models"],
      expected: true,
    },
    { name: "model parent write", patch: {}, path: ["models"], expected: true },
    {
      name: "plugin load path",
      patch: { plugins: { load: { paths: ["/new-plugin-root"] } } },
      path: ["plugins", "load", "paths"],
      expected: true,
    },
    {
      name: "plugin activation",
      patch: { plugins: { entries: { custom: { enabled: false } } } },
      path: ["plugins", "entries", "custom", "enabled"],
      expected: true,
    },
    {
      name: "channel activation",
      patch: { channels: { telegram: { enabled: true } } },
      path: ["channels", "telegram", "enabled"],
      expected: true,
    },
  ])("selects catalog normalization for $name", ({ patch, path, expected }) => {
    const before = catalogConfig();
    const after = { ...before, ...patch } as OpenClawConfig;
    expect(
      shouldNormalizeConfigMutationProviderCatalogs({
        before,
        after,
        touchedPaths: [path],
        env: {
          HOME: "/isolated-home",
          OPENCLAW_STATE_DIR: "/isolated-state",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      }),
    ).toBe(expected);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(0);
  });

  it("normalizes catalog values changed indirectly by a parent operation", () => {
    const before = catalogConfig();
    const after = catalogConfig("changed");
    expect(
      shouldNormalizeConfigMutationProviderCatalogs({
        before,
        after,
        touchedPaths: [],
      }),
    ).toBe(true);
  });

  it.each(["defaults", "entries", "list"] as const)(
    "normalizes all %s agent model fields without discovering plugins",
    async (scope) => {
      const ref = " together/meta-llama/Llama-3.3-70B-Instruct-Turbo ";
      const normalized = "together/meta-llama/Llama-3.3-70B-Instruct-Turbo";
      const selection = { primary: ref, fallbacks: [ref] };
      const expectedSelection = { primary: normalized, fallbacks: [normalized] };
      const fields = {
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
      const expected = {
        model: expectedSelection,
        imageModel: expectedSelection,
        voiceModel: expectedSelection,
        pdfModel: expectedSelection,
        utilityModel: normalized,
        mediaModels: {
          image: expectedSelection,
          video: expectedSelection,
          music: expectedSelection,
        },
        heartbeat: { model: normalized },
        subagents: { model: expectedSelection },
        compaction: { model: normalized, memoryFlush: { model: normalized } },
        models: { [normalized]: { alias: "test" } },
      };
      const wrap = (value: unknown) => ({
        agents: {
          [scope]: scope === "defaults" ? value : scope === "list" ? [value] : { a: value },
        },
      });
      expect(await normalizeConfigMutationModelRefs(wrap(fields) as OpenClawConfig)).toEqual(
        wrap(expected),
      );
      expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(0);
    },
  );

  it.each([false, true])(
    "applies provider policies with prepared metadata=%s",
    async (prepared) => {
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
      expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(0);
    },
  );

  it.each(["single", "merged"] as const)(
    "keeps %s workspace metadata out of global model normalization",
    async (scope) => {
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
      expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(0);
    },
  );

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
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(0);
  });
});
