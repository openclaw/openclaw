import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/types.js";

const resolveManifestModelIdNormalizationPoliciesMock = vi.hoisted(() => vi.fn());
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());

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
});
