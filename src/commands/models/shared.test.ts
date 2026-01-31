import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadModelCatalog = vi.fn();
const mockFindModelInCatalog = vi.fn();
const mockModelSupportsVision = vi.fn();

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: () => mockLoadModelCatalog(),
  findModelInCatalog: (catalog: unknown[], provider: string, modelId: string) =>
    mockFindModelInCatalog(catalog, provider, modelId),
  modelSupportsVision: (entry: unknown) => mockModelSupportsVision(entry),
}));

describe("validateModelInCatalog", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLoadModelCatalog.mockReset();
    mockFindModelInCatalog.mockReset();
    mockModelSupportsVision.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns valid: true when model is found in catalog", async () => {
    const mockEntry = { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" };
    mockLoadModelCatalog.mockResolvedValue([mockEntry]);
    mockFindModelInCatalog.mockReturnValue(mockEntry);

    const { validateModelInCatalog } = await import("./shared.js");
    const result = await validateModelInCatalog("anthropic", "claude-opus-4-5");

    expect(result.valid).toBe(true);
    expect(result.entry).toEqual(mockEntry);
    expect(result.suggestions).toBeUndefined();
  });

  it("returns valid: false with suggestions when model not found", async () => {
    const catalog = [
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
    ];
    mockLoadModelCatalog.mockResolvedValue(catalog);
    mockFindModelInCatalog.mockReturnValue(undefined);

    const { validateModelInCatalog } = await import("./shared.js");
    const result = await validateModelInCatalog("anthropic", "claude-sonnet-4");

    expect(result.valid).toBe(false);
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions?.length).toBeGreaterThan(0);
    // claude-sonnet-4-5 should be suggested as it's similar
    expect(result.suggestions).toContain("anthropic/claude-sonnet-4-5");
  });

  it("returns valid: true when catalog is empty (graceful degradation)", async () => {
    mockLoadModelCatalog.mockResolvedValue([]);

    const { validateModelInCatalog } = await import("./shared.js");
    const result = await validateModelInCatalog("anthropic", "claude-opus-4-5");

    expect(result.valid).toBe(true);
    expect(result.entry).toBeUndefined();
  });

  it("returns valid: true when catalog fails to load (graceful degradation)", async () => {
    mockLoadModelCatalog.mockRejectedValue(new Error("Failed to load catalog"));

    const { validateModelInCatalog } = await import("./shared.js");
    const result = await validateModelInCatalog("anthropic", "claude-opus-4-5");

    expect(result.valid).toBe(true);
    expect(result.entry).toBeUndefined();
  });

  it("fuzzy matches similar model names within same provider", async () => {
    const catalog = [
      { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai" },
    ];
    mockLoadModelCatalog.mockResolvedValue(catalog);
    mockFindModelInCatalog.mockReturnValue(undefined);

    const { validateModelInCatalog } = await import("./shared.js");
    const result = await validateModelInCatalog("openai", "gpt-4");

    expect(result.valid).toBe(false);
    expect(result.suggestions).toBeDefined();
    // gpt-4o and gpt-4-turbo should be suggested
    expect(result.suggestions?.some((s) => s.includes("gpt-4"))).toBe(true);
  });
});

describe("validateImageModel", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLoadModelCatalog.mockReset();
    mockFindModelInCatalog.mockReset();
    mockModelSupportsVision.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns supportsVision: true when model supports image input", async () => {
    const mockEntry = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      input: ["text", "image"],
    };
    mockLoadModelCatalog.mockResolvedValue([mockEntry]);
    mockFindModelInCatalog.mockReturnValue(mockEntry);
    mockModelSupportsVision.mockReturnValue(true);

    const { validateImageModel } = await import("./shared.js");
    const result = await validateImageModel("openai", "gpt-4o");

    expect(result.valid).toBe(true);
    expect(result.supportsVision).toBe(true);
  });

  it("returns supportsVision: false when model does not support image input", async () => {
    const mockEntry = {
      id: "gpt-3.5-turbo",
      name: "GPT-3.5 Turbo",
      provider: "openai",
      input: ["text"],
    };
    mockLoadModelCatalog.mockResolvedValue([mockEntry]);
    mockFindModelInCatalog.mockReturnValue(mockEntry);
    mockModelSupportsVision.mockReturnValue(false);

    const { validateImageModel } = await import("./shared.js");
    const result = await validateImageModel("openai", "gpt-3.5-turbo");

    expect(result.valid).toBe(true);
    expect(result.supportsVision).toBe(false);
  });

  it("returns valid: false when model not found", async () => {
    mockLoadModelCatalog.mockResolvedValue([{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }]);
    mockFindModelInCatalog.mockReturnValue(undefined);

    const { validateImageModel } = await import("./shared.js");
    const result = await validateImageModel("openai", "nonexistent-model");

    expect(result.valid).toBe(false);
    expect(result.supportsVision).toBeUndefined();
  });
});
