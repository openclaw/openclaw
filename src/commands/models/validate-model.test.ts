import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";

const mockLoadModelCatalog = vi.fn<() => Promise<ModelCatalogEntry[]>>();

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: (..._args: unknown[]) => mockLoadModelCatalog(),
}));

import { validateModelAgainstCatalog } from "./validate-model.js";

const SAMPLE_CATALOG: ModelCatalogEntry[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

describe("validateModelAgainstCatalog", () => {
  beforeEach(() => {
    mockLoadModelCatalog.mockReset();
  });

  it("accepts a valid model with provider prefix", async () => {
    mockLoadModelCatalog.mockResolvedValue(SAMPLE_CATALOG);
    const result = await validateModelAgainstCatalog("anthropic/claude-opus-4-6");
    expect(result).toEqual({ valid: true, key: "anthropic/claude-opus-4-6" });
  });

  it("accepts a valid model without provider prefix (uses default)", async () => {
    mockLoadModelCatalog.mockResolvedValue(SAMPLE_CATALOG);
    const result = await validateModelAgainstCatalog("claude-opus-4-6");
    expect(result).toEqual({ valid: true, key: "anthropic/claude-opus-4-6" });
  });

  it("rejects an invalid model and suggests alternatives", async () => {
    mockLoadModelCatalog.mockResolvedValue(SAMPLE_CATALOG);
    const result = await validateModelAgainstCatalog("anthropic/claude-opus-4-6-v1:0");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("not found");
      expect(result.message).toContain("Did you mean");
      expect(result.message).toContain("claude-opus-4-6");
    }
  });

  it("rejects a completely wrong model name", async () => {
    mockLoadModelCatalog.mockResolvedValue(SAMPLE_CATALOG);
    const result = await validateModelAgainstCatalog("anthropic/this-model-does-not-exist-at-all");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("not found");
      expect(result.message).toContain("openclaw models list");
    }
  });

  it("is case-insensitive for matching", async () => {
    mockLoadModelCatalog.mockResolvedValue(SAMPLE_CATALOG);
    const result = await validateModelAgainstCatalog("Anthropic/Claude-Opus-4-6");
    expect(result).toEqual({ valid: true, key: "anthropic/claude-opus-4-6" });
  });

  it("allows through when catalog is empty (no auth configured)", async () => {
    mockLoadModelCatalog.mockResolvedValue([]);
    const result = await validateModelAgainstCatalog("anthropic/claude-opus-4-6");
    expect(result.valid).toBe(true);
  });

  it("allows through when catalog fails to load", async () => {
    mockLoadModelCatalog.mockRejectedValue(new Error("auth not configured"));
    const result = await validateModelAgainstCatalog("anthropic/claude-opus-4-6");
    expect(result.valid).toBe(true);
  });

  it("rejects empty model reference", async () => {
    mockLoadModelCatalog.mockResolvedValue(SAMPLE_CATALOG);
    const result = await validateModelAgainstCatalog("");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("Invalid model reference");
    }
  });

  it("suggests cross-provider models when close match exists", async () => {
    mockLoadModelCatalog.mockResolvedValue(SAMPLE_CATALOG);
    const result = await validateModelAgainstCatalog("openai/claude-opus-4-6");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("Did you mean");
      expect(result.message).toContain("anthropic/claude-opus-4-6");
    }
  });
});
