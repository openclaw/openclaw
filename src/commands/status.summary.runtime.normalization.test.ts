import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/types.js";

const resolveManifestModelIdNormalizationPoliciesMock = vi.hoisted(() => vi.fn());
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());
const loadManifestMetadataSnapshotMock = vi.hoisted(() => vi.fn());

// Status alias resolution must reuse current metadata, never scan plugin manifests.
vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>();
  loadManifestMetadataSnapshotMock.mockImplementation(actual.loadManifestMetadataSnapshot);
  return { ...actual, loadManifestMetadataSnapshot: loadManifestMetadataSnapshotMock };
});

vi.mock("../plugins/manifest-model-id-normalization.js", () => ({
  resolveManifestModelIdNormalizationPolicies: resolveManifestModelIdNormalizationPoliciesMock,
}));

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeProviderModelIdWithRuntimeMock,
}));

describe("statusSummaryRuntime configured model normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveManifestModelIdNormalizationPoliciesMock.mockReset();
    normalizeProviderModelIdWithRuntimeMock.mockReset();
    loadManifestMetadataSnapshotMock.mockClear();
  });

  it("skips manifest and plugin model normalization for configured model refs", async () => {
    const { statusSummaryRuntime } = await import("../status/summary.runtime.js");

    const resolveConfigured = (cfg: OpenClawConfig) =>
      statusSummaryRuntime.resolveConfiguredStatusModelRef({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      });
    expect(
      resolveConfigured({ agents: { defaults: { model: { primary: "openai-codex/gpt-5.5" } } } }),
    ).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
    expect(
      resolveConfigured({
        agents: {
          defaults: {
            model: { primary: "fast-codex" },
            models: { "openai-codex/gpt-5.5": { alias: "fast-codex" } },
          },
        },
      }),
    ).toEqual({ provider: "openai-codex", model: "gpt-5.5" });

    expect(resolveManifestModelIdNormalizationPoliciesMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("keeps a declared provider authoritative over a cross-provider alias", async () => {
    const [
      { statusSummaryRuntime },
      { createPluginMetadataSnapshotFixture },
      { withPluginRuntimeGenerationScope },
    ] = await Promise.all([
      import("../status/summary.runtime.js"),
      import("../plugins/plugin-metadata.test-support.js"),
      import("../plugins/runtime/generation-scope.js"),
    ]);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "anthropic/fixture-local",
          models: { "openai/fixture-other": { alias: "anthropic/fixture-local" } },
        },
      },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "anthropic", providers: ["anthropic"] }],
    });

    const resolved = withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      statusSummaryRuntime.resolveConfiguredStatusModelRef({
        cfg,
        defaultProvider: "openai",
        defaultModel: "fixture-fallback",
      }),
    );
    expect(resolved).toEqual({ provider: "anthropic", model: "fixture-local" });
    expect(resolveManifestModelIdNormalizationPoliciesMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("resolves a cross-provider qualified alias without scanning a Gateway workspace", async () => {
    const [{ statusSummaryRuntime }, runtime, { createEmptyPluginRegistry }] = await Promise.all([
      import("../status/summary.runtime.js"),
      import("../plugins/runtime.js"),
      import("../plugins/registry-empty.js"),
    ]);
    runtime.setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp");
    try {
      // A provider-shaped alias for another provider consults declared providers.
      statusSummaryRuntime.resolveConfiguredStatusModelRef({
        cfg: {
          agents: {
            defaults: {
              model: "anthropic/fixture-local",
              models: { "openai/fixture-other": { alias: "anthropic/fixture-local" } },
            },
          },
        },
        defaultProvider: "openai",
        defaultModel: "fixture-fallback",
      });
      expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
    } finally {
      runtime.resetPluginRuntimeStateForTest();
    }
  });

  it("resolves agent-local aliases without model normalization", async () => {
    const { statusSummaryRuntime } = await import("../status/summary.runtime.js");
    const globalAlias = { "openai/fixture-global": { alias: "fast" } };
    const localAlias = { "anthropic/fixture-local": { alias: "fast" } };
    type Agent = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
    const aliasCase = (
      name: string,
      agent: Agent,
      defaults: Record<string, { alias?: string }> = globalAlias,
      expected = { provider: "anthropic", model: "fixture-local" },
    ) => ({ name, agent, defaults, expected });
    const cases = [
      aliasCase("agent-only alias", { models: localAlias, model: "fast" }, {}),
      aliasCase("shadows global", { models: localAlias, model: "fast" }),
      aliasCase("inherited primary", { models: localAlias }),
      aliasCase(
        "clears inherited alias",
        { models: { "openai/fixture-global": { alias: "" } } },
        globalAlias,
        { provider: "openai", model: "fast" },
      ),
      aliasCase("keeps inherited alias", { models: { "openai/fixture-global": {} } }, globalAlias, {
        provider: "openai",
        model: "fixture-global",
      }),
      aliasCase(
        "ignores case and whitespace",
        { models: { "anthropic/fixture-local": { alias: " fast " } }, model: "  FAST  " },
        {},
      ),
      aliasCase("provider-qualified", { models: localAlias, model: "anthropic/fast" }),
      aliasCase("profile-qualified", { models: localAlias, model: "fast@work" }, {}),
      aliasCase(
        "bare model",
        { models: { "anthropic/fixture-local": {} }, model: "fixture-local" },
        {},
      ),
      aliasCase("ACP primary", {
        models: localAlias,
        model: "fast",
        runtime: { type: "acp", acp: { agent: "fixture" } },
      }),
    ];
    for (const { name, defaults, agent, expected } of cases) {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "fast", models: defaults },
          entries: { work: agent },
        },
      };

      expect(
        statusSummaryRuntime.resolveConfiguredStatusModelRef({
          cfg,
          agentId: "work",
          defaultProvider: "openai",
          defaultModel: "fixture-fallback",
        }),
        name,
      ).toEqual(expected);
    }
    expect(resolveManifestModelIdNormalizationPoliciesMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("skips manifest and plugin model normalization for providerless persisted session models", async () => {
    const { statusSummaryRuntime } = await import("../status/summary.runtime.js");
    const configured = { provider: "anthropic", model: "claude-sonnet-4-6" };

    normalizeProviderModelIdWithRuntimeMock.mockReturnValue("runtime-normalized-opus");

    for (const entry of [
      { model: "opus-4.6" },
      { model: "fallback-runtime-model", modelOverride: "opus-4.6" },
    ]) {
      expect(statusSummaryRuntime.resolveSessionModelRef(configured, entry)).toEqual({
        provider: "anthropic",
        model: "opus-4.6",
      });
    }
    const ref = { provider: "anthropic", model: "opus-4.6", defaultProvider: "anthropic" };
    expect(statusSummaryRuntime.resolveStatusModelLookupRef(ref)).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(resolveManifestModelIdNormalizationPoliciesMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "explicit provider override",
      entry: { providerOverride: "openai", modelOverride: "gpt-5.5", model: "opus-4.6" },
      expected: { provider: "openai", model: "gpt-5.5" },
    },
    {
      name: "qualified model override",
      entry: { modelOverride: "openai/gpt-5.5", model: "opus-4.6" },
      expected: { provider: "openai", model: "gpt-5.5" },
    },
    {
      name: "providerless model override preserves its stored spelling",
      entry: { modelOverride: "opus-4.6", modelProvider: "openai", model: "gpt-5.5" },
      expected: { provider: "anthropic", model: "opus-4.6" },
    },
    {
      name: "empty override falls back to the stored model",
      entry: { providerOverride: "openai", modelOverride: "  ", model: "opus-4.6" },
      expected: { provider: "anthropic", model: "opus-4.6" },
    },
  ])(
    "resolves session selection before display normalization: $name",
    async ({ entry, expected }) => {
      const { statusSummaryRuntime } = await import("../status/summary.runtime.js");

      expect(
        statusSummaryRuntime.resolveSessionModelRef(
          { provider: "anthropic", model: "claude-sonnet-4-6" },
          entry,
        ),
      ).toEqual(expected);
      expect(resolveManifestModelIdNormalizationPoliciesMock).not.toHaveBeenCalled();
      expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
    },
  );
});
