import { describe, expect, it } from "vitest";
import {
  classifyInternalToolOutputShape,
  hasProviderInventoryDetails,
} from "./tool-output-shapes.js";

describe("hasProviderInventoryDetails", () => {
  it("matches results with details.providers array", () => {
    expect(
      hasProviderInventoryDetails({
        details: {
          providers: [{ id: "openai", defaultModel: "sora-2", models: ["sora-2"] }],
        },
      }),
    ).toBe(true);
  });

  it("matches an empty providers array (still inventory shape)", () => {
    expect(hasProviderInventoryDetails({ details: { providers: [] } })).toBe(true);
  });

  it("rejects results without details", () => {
    expect(hasProviderInventoryDetails({})).toBe(false);
    expect(hasProviderInventoryDetails(null)).toBe(false);
    expect(hasProviderInventoryDetails(undefined)).toBe(false);
  });

  it("rejects details with non-array providers", () => {
    expect(hasProviderInventoryDetails({ details: { providers: "openai" } })).toBe(false);
    expect(hasProviderInventoryDetails({ details: { providers: { id: "openai" } } })).toBe(false);
  });

  it("rejects details when providers key is missing", () => {
    expect(hasProviderInventoryDetails({ details: { models: ["sora-2"] } })).toBe(false);
  });

  it("rejects when details itself is an array", () => {
    expect(hasProviderInventoryDetails({ details: [{ providers: [] }] })).toBe(false);
  });
});

describe("classifyInternalToolOutputShape", () => {
  it("returns 'provider-inventory' for provider-inventory shape", () => {
    expect(
      classifyInternalToolOutputShape({
        details: { providers: [{ id: "openai" }] },
      }),
    ).toBe("provider-inventory");
  });

  it("returns undefined for ordinary tool results", () => {
    expect(
      classifyInternalToolOutputShape({ content: [{ type: "text", text: "ok" }] }),
    ).toBeUndefined();
    expect(classifyInternalToolOutputShape(undefined)).toBeUndefined();
    expect(classifyInternalToolOutputShape(null)).toBeUndefined();
  });
});
