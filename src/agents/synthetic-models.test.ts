import { describe, expect, it } from "vitest";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_MODEL_CATALOG,
  SYNTHETIC_DEFAULT_MODEL_ID,
  SYNTHETIC_DEFAULT_COST,
  SYNTHETIC_BASE_URL,
} from "./synthetic-models.js";

describe("SYNTHETIC_MODEL_CATALOG", () => {
  it("contains at least one model", () => {
    expect(SYNTHETIC_MODEL_CATALOG.length).toBeGreaterThan(0);
  });

  it("all entries have required fields", () => {
    for (const entry of SYNTHETIC_MODEL_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(typeof entry.reasoning).toBe("boolean");
      expect(entry.input.length).toBeGreaterThan(0);
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.maxTokens).toBeGreaterThan(0);
    }
  });

  it("has unique model IDs", () => {
    const ids = SYNTHETIC_MODEL_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the default model", () => {
    const found = SYNTHETIC_MODEL_CATALOG.find((e) => e.id === SYNTHETIC_DEFAULT_MODEL_ID);
    expect(found).toBeDefined();
  });
});

describe("buildSyntheticModelDefinition", () => {
  it("builds definition from catalog entry", () => {
    const entry = SYNTHETIC_MODEL_CATALOG[0];
    const def = buildSyntheticModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
    expect(def.cost).toEqual(SYNTHETIC_DEFAULT_COST);
  });

  it("copies input array (not shared reference)", () => {
    const entry = SYNTHETIC_MODEL_CATALOG[0];
    const def = buildSyntheticModelDefinition(entry);
    expect(def.input).toEqual([...entry.input]);
    expect(def.input).not.toBe(entry.input);
  });
});

describe("constants", () => {
  it("SYNTHETIC_BASE_URL is a valid URL", () => {
    expect(() => new URL(SYNTHETIC_BASE_URL)).not.toThrow();
  });

  it("SYNTHETIC_DEFAULT_COST has zero costs", () => {
    expect(SYNTHETIC_DEFAULT_COST.input).toBe(0);
    expect(SYNTHETIC_DEFAULT_COST.output).toBe(0);
    expect(SYNTHETIC_DEFAULT_COST.cacheRead).toBe(0);
    expect(SYNTHETIC_DEFAULT_COST.cacheWrite).toBe(0);
  });
});
