import { describe, expect, it, vi } from "vitest";

const mockBuildAllowedModelSet = vi.fn();
const mockResolveModelRefFromString = vi.fn();
const mockBuildModelAliasIndex = vi.fn();
const mockModelKey = vi.fn((provider: string, model: string) => `${provider}/${model}`);

vi.mock("../../agents/model-selection.js", () => ({
  buildAllowedModelSet: mockBuildAllowedModelSet,
  buildModelAliasIndex: mockBuildModelAliasIndex,
  modelKey: mockModelKey,
  resolveModelRefFromString: mockResolveModelRefFromString,
}));

const mockFindModelInCatalog = vi.fn();
const mockModelSupportsVision = vi.fn();
const mockLoadModelCatalog = vi.fn();

vi.mock("../../agents/model-catalog.js", () => ({
  findModelInCatalog: mockFindModelInCatalog,
  modelSupportsVision: mockModelSupportsVision,
  loadModelCatalog: mockLoadModelCatalog,
}));

const { prepareImageModelFallbacks, resolveModelSupportsVision } =
  await import("./image-model-helpers.js");

describe("prepareImageModelFallbacks", () => {
  const baseParams = {
    cfg: {} as never,
    agentId: "main",
    aliasIndex: {} as never,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
  };

  it("returns empty array when fallbacks is empty", () => {
    const result = prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: [],
    });
    expect(result).toEqual([]);
  });

  it("returns resolved fallback when in allowlist", () => {
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedKeys: new Set(["openai/gpt-4o"]),
    });
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "openai", model: "gpt-4o" },
    });

    const result = prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: ["openai/gpt-4o"],
    });
    expect(result).toEqual(["openai/gpt-4o"]);
  });

  it("filters out fallbacks not in allowlist", () => {
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedKeys: new Set(["openai/gpt-4o"]),
    });
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "anthropic", model: "claude-opus-4-6" },
    });

    const result = prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: ["anthropic/claude-opus-4-6"],
    });
    expect(result).toEqual([]);
  });

  it("allows any model when allowlist is empty", () => {
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: true,
      allowedKeys: new Set(),
    });
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "openai", model: "gpt-4o" },
    });

    const result = prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: ["openai/gpt-4o"],
    });
    expect(result).toEqual(["openai/gpt-4o"]);
  });

  it("uses imageModelProvider for resolution when available", () => {
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: true,
      allowedKeys: new Set(),
    });
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "openai", model: "gpt-4o-mini" },
    });

    prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: ["gpt-4o-mini"],
      imageModelProvider: "openai",
    });

    expect(mockResolveModelRefFromString).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "gpt-4o-mini",
        defaultProvider: "openai",
      }),
    );
  });

  it("falls back to raw string when alias resolution fails but string is in allowlist", () => {
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedKeys: new Set(["gpt-4o"]),
    });
    mockResolveModelRefFromString.mockReturnValue(null);

    const result = prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: ["gpt-4o"],
    });
    expect(result).toEqual(["gpt-4o"]);
  });

  it("filters out empty and whitespace-only fallbacks", () => {
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: true,
      allowedKeys: new Set(),
    });
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "openai", model: "gpt-4o" },
    });

    const result = prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: ["", "  ", "openai/gpt-4o"],
    });
    expect(result).toEqual(["openai/gpt-4o"]);
  });

  it("processes multiple fallbacks in order", () => {
    mockBuildAllowedModelSet.mockReturnValue({
      allowAny: false,
      allowedKeys: new Set(["openai/gpt-4o", "openai/gpt-4o-mini"]),
    });
    mockResolveModelRefFromString.mockImplementation((params: { raw: string }) => {
      if (params.raw === "anthropic/claude-opus-4-6") {
        return { ref: { provider: "anthropic", model: "claude-opus-4-6" } };
      }
      if (params.raw === "openai/gpt-4o") {
        return { ref: { provider: "openai", model: "gpt-4o" } };
      }
      if (params.raw === "openai/gpt-4o-mini") {
        return { ref: { provider: "openai", model: "gpt-4o-mini" } };
      }
      return null;
    });

    const result = prepareImageModelFallbacks({
      ...baseParams,
      fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-4o", "openai/gpt-4o-mini"],
    });
    // First is filtered out (not in allowlist), second and third are kept
    expect(result).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
  });
});

describe("resolveModelSupportsVision", () => {
  const baseParams = {
    provider: "openai",
    model: "gpt-4o",
    defaultProvider: "anthropic",
    cfg: {} as never,
  };

  it("returns true when model matches imageModelConfig primary", async () => {
    mockBuildModelAliasIndex.mockReturnValue({});
    // collectImageModelKeys will resolve the primary and add it to keys
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "openai", model: "gpt-4o" },
    });

    const result = await resolveModelSupportsVision({
      ...baseParams,
      imageModelConfig: { primary: "openai/gpt-4o" } as never,
    });
    expect(result).toBe(true);
  });

  it("returns true when model matches imageModelConfig fallback", async () => {
    mockBuildModelAliasIndex.mockReturnValue({});
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "openai", model: "gpt-4o" },
    });

    const result = await resolveModelSupportsVision({
      ...baseParams,
      imageModelConfig: { fallbacks: ["openai/gpt-4o"] } as never,
    });
    expect(result).toBe(true);
  });

  it("checks catalog when model not in imageModelConfig", async () => {
    mockBuildModelAliasIndex.mockReturnValue({});
    mockResolveModelRefFromString.mockReturnValue(null);
    mockLoadModelCatalog.mockResolvedValue([]);
    mockFindModelInCatalog.mockReturnValue({ id: "gpt-4o", provider: "openai" });
    mockModelSupportsVision.mockReturnValue(true);

    const result = await resolveModelSupportsVision({
      ...baseParams,
      imageModelConfig: { primary: "anthropic/claude-sonnet-4-6" } as never,
    });
    expect(result).toBe(true);
    expect(mockFindModelInCatalog).toHaveBeenCalledWith([], "openai", "gpt-4o");
  });

  it("returns false when catalog says model does not support vision", async () => {
    mockBuildModelAliasIndex.mockReturnValue({});
    mockResolveModelRefFromString.mockReturnValue(null);
    mockLoadModelCatalog.mockResolvedValue([]);
    mockFindModelInCatalog.mockReturnValue({ id: "gpt-4o", provider: "openai" });
    mockModelSupportsVision.mockReturnValue(false);

    const result = await resolveModelSupportsVision({
      ...baseParams,
      imageModelConfig: { primary: "anthropic/claude-sonnet-4-6" } as never,
    });
    expect(result).toBe(false);
  });

  it("returns false when catalog lookup fails", async () => {
    mockBuildModelAliasIndex.mockReturnValue({});
    mockResolveModelRefFromString.mockReturnValue(null);
    mockLoadModelCatalog.mockRejectedValue(new Error("catalog error"));

    const result = await resolveModelSupportsVision({
      ...baseParams,
      imageModelConfig: { primary: "anthropic/claude-sonnet-4-6" } as never,
    });
    expect(result).toBe(false);
  });

  it("uses custom loadModelCatalog when provided", async () => {
    mockBuildModelAliasIndex.mockReturnValue({});
    mockResolveModelRefFromString.mockReturnValue(null);
    const customLoader = vi.fn().mockResolvedValue([]);
    mockFindModelInCatalog.mockReturnValue({ id: "gpt-4o", provider: "openai" });
    mockModelSupportsVision.mockReturnValue(true);

    await resolveModelSupportsVision({
      ...baseParams,
      imageModelConfig: { primary: "anthropic/claude-sonnet-4-6" } as never,
      loadModelCatalog: customLoader,
    });
    expect(customLoader).toHaveBeenCalledWith({ config: {} });
  });

  it("checks catalog when imageModelConfig is undefined", async () => {
    mockBuildModelAliasIndex.mockReturnValue({});
    mockLoadModelCatalog.mockResolvedValue([]);
    mockFindModelInCatalog.mockReturnValue({ id: "gpt-4o", provider: "openai" });
    mockModelSupportsVision.mockReturnValue(true);

    const result = await resolveModelSupportsVision({
      ...baseParams,
    });
    expect(result).toBe(true);
  });
});
