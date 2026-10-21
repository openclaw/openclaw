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
    const cases: Array<{
      name: string;
      defaults: Record<string, { alias?: string }>;
      models: Record<string, { alias?: string }>;
      primary?: string;
      runtime?: { type: "acp"; acp: { agent: string } };
      expected: { provider: string; model: string };
    }> = [
      {
        name: "agent-only alias",
        defaults: {},
        models: { "anthropic/fixture-local": { alias: "fast" } },
        primary: "fast",
        expected: { provider: "anthropic", model: "fixture-local" },
      },
      {
        name: "agent alias shadows the global alias",
        defaults: { "openai/fixture-global": { alias: "fast" } },
        models: { "anthropic/fixture-local": { alias: "fast" } },
        primary: "fast",
        expected: { provider: "anthropic", model: "fixture-local" },
      },
      {
        name: "inherited primary uses the agent alias",
        defaults: { "openai/fixture-global": { alias: "fast" } },
        models: { "anthropic/fixture-local": { alias: "fast" } },
        expected: { provider: "anthropic", model: "fixture-local" },
      },
      {
        name: "empty agent alias clears the inherited alias",
        defaults: { "openai/fixture-global": { alias: "fast" } },
        models: { "openai/fixture-global": { alias: "" } },
        expected: { provider: "openai", model: "fast" },
      },
      {
        name: "omitted agent alias keeps the inherited alias",
        defaults: { "openai/fixture-global": { alias: "fast" } },
        models: { "openai/fixture-global": {} },
        expected: { provider: "openai", model: "fixture-global" },
      },
      {
        name: "agent alias matching ignores case and whitespace",
        defaults: {},
        models: { "anthropic/fixture-local": { alias: " fast " } },
        primary: "  FAST  ",
        expected: { provider: "anthropic", model: "fixture-local" },
      },
      {
        name: "provider-qualified agent alias",
        defaults: { "openai/fixture-global": { alias: "fast" } },
        models: { "anthropic/fixture-local": { alias: "fast" } },
        primary: "anthropic/fast",
        expected: { provider: "anthropic", model: "fixture-local" },
      },
      {
        name: "profile-qualified agent alias",
        defaults: {},
        models: { "anthropic/fixture-local": { alias: "fast" } },
        primary: "fast@work",
        expected: { provider: "anthropic", model: "fixture-local" },
      },
      {
        name: "bare model inferred from agent metadata",
        defaults: {},
        models: { "anthropic/fixture-local": {} },
        primary: "fixture-local",
        expected: { provider: "anthropic", model: "fixture-local" },
      },
      {
        name: "ACP primary stays separate from the native fallback",
        defaults: { "openai/fixture-global": { alias: "fast" } },
        models: { "anthropic/fixture-local": { alias: "fast" } },
        primary: "fast",
        runtime: { type: "acp", acp: { agent: "fixture" } },
        expected: { provider: "anthropic", model: "fixture-local" },
      },
    ];
    for (const { name, defaults, models, primary, runtime, expected } of cases) {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "fast", models: defaults },
          entries: { work: { ...(primary ? { model: primary } : {}), models, runtime } },
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
    expect(statusSummaryRuntime.resolveStatusModelComparisonLabel(ref)).toBe(
      "anthropic/claude-opus-4-6",
    );
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
