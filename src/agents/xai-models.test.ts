import { describe, expect, it } from "vitest";
import {
  buildXaiModelDefinition,
  XAI_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MODEL_REF,
  XAI_MODEL_CATALOG,
} from "./xai-models.js";

describe("XAI_MODEL_CATALOG", () => {
  it("contains expected models", () => {
    expect(XAI_MODEL_CATALOG).toHaveLength(5);
    const ids = XAI_MODEL_CATALOG.map((m) => m.id);
    expect(ids).toContain("grok-4-1-fast-reasoning");
    expect(ids).toContain("grok-4-1-fast-non-reasoning");
    expect(ids).toContain("grok-code-fast-1");
    expect(ids).toContain("grok-3");
    expect(ids).toContain("grok-3-mini");
  });

  it("has correct default model constants", () => {
    expect(XAI_DEFAULT_MODEL_ID).toBe("grok-4-1-fast-reasoning");
    expect(XAI_DEFAULT_MODEL_REF).toBe("xai/grok-4-1-fast-reasoning");
    expect(XAI_BASE_URL).toBe("https://api.x.ai/v1");
  });
});

describe("buildXaiModelDefinition", () => {
  it("preserves model properties", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-4-1-fast-reasoning");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const def = buildXaiModelDefinition(entry);

    expect(def.id).toBe("grok-4-1-fast-reasoning");
    expect(def.name).toBe("Grok 4.1 Fast Reasoning");
    expect(def.reasoning).toBe(true);
    expect(def.input).toEqual(["text"]);
    expect(def.cost).toEqual({ input: 0.2, output: 0.5, cacheRead: 0, cacheWrite: 0 });
    expect(def.contextWindow).toBe(2000000);
    expect(def.maxTokens).toBe(30000);
  });

  it("grok-4-1-fast-reasoning has correct compat flags", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-4-1-fast-reasoning");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const def = buildXaiModelDefinition(entry);
    expect(def.compat?.supportsReasoningEffort).toBe(false);
  });

  it("grok-4-1-fast-non-reasoning has no compat flags", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-4-1-fast-non-reasoning");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const def = buildXaiModelDefinition(entry);
    expect(def.compat).toBeUndefined();
  });

  it("grok-code-fast-1 has correct compat flags", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-code-fast-1");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const def = buildXaiModelDefinition(entry);
    expect(def.compat?.supportsReasoningEffort).toBe(false);
  });

  it("grok-3 has correct compat flags", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-3");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const def = buildXaiModelDefinition(entry);
    expect(def.compat?.supportsReasoningEffort).toBe(true);
  });

  it("grok-3 supports multimodal input", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-3");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    expect(entry.input).toContain("text");
    expect(entry.input).toContain("image");
  });

  it("grok-3-mini has correct compat flags", () => {
    const entry = XAI_MODEL_CATALOG.find((m) => m.id === "grok-3-mini");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    const def = buildXaiModelDefinition(entry);
    expect(def.compat?.supportsReasoningEffort).toBe(true);
  });

  it("all models have correct pricing", () => {
    const pricingMap: Record<string, { input: number; output: number; cacheRead?: number }> = {
      "grok-4-1-fast-reasoning": { input: 0.2, output: 0.5, cacheRead: 0 },
      "grok-4-1-fast-non-reasoning": { input: 0.2, output: 0.5, cacheRead: 0 },
      "grok-code-fast-1": { input: 0.2, output: 1.5, cacheRead: 0.02 },
      "grok-3": { input: 3.0, output: 15.0, cacheRead: 0 },
      "grok-3-mini": { input: 0.3, output: 0.5, cacheRead: 0 },
    };

    for (const entry of XAI_MODEL_CATALOG) {
      const expected = pricingMap[entry.id];
      expect(expected).toBeDefined();
      if (!expected) {
        continue;
      }

      expect(entry.cost.input).toBe(expected.input);
      expect(entry.cost.output).toBe(expected.output);
      expect(entry.cost.cacheRead).toBe(expected.cacheRead);
      expect(entry.cost.cacheWrite).toBe(0);
    }
  });

  it("all models have correct context windows", () => {
    const contextMap: Record<string, number> = {
      "grok-4-1-fast-reasoning": 2000000,
      "grok-4-1-fast-non-reasoning": 2000000,
      "grok-code-fast-1": 256000,
      "grok-3": 1000000,
      "grok-3-mini": 131072,
    };

    for (const entry of XAI_MODEL_CATALOG) {
      const expected = contextMap[entry.id];
      expect(expected).toBeDefined();
      expect(entry.contextWindow).toBe(expected);
    }
  });

  it("all models have correct max tokens", () => {
    const maxTokensMap: Record<string, number> = {
      "grok-4-1-fast-reasoning": 30000,
      "grok-4-1-fast-non-reasoning": 30000,
      "grok-code-fast-1": 10000,
      "grok-3": 4096,
      "grok-3-mini": 8192,
    };

    for (const entry of XAI_MODEL_CATALOG) {
      const expected = maxTokensMap[entry.id];
      expect(expected).toBeDefined();
      expect(entry.maxTokens).toBe(expected);
    }
  });

  it("all reasoning models have reasoning flag set", () => {
    const reasoningModels = new Set([
      "grok-4-1-fast-reasoning",
      "grok-code-fast-1",
      "grok-3",
      "grok-3-mini",
    ]);
    const nonReasoningModels = new Set(["grok-4-1-fast-non-reasoning"]);

    for (const entry of XAI_MODEL_CATALOG) {
      if (reasoningModels.has(entry.id)) {
        expect(entry.reasoning).toBe(true);
      } else if (nonReasoningModels.has(entry.id)) {
        expect(entry.reasoning).toBe(false);
      }
    }
  });
});
