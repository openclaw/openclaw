import { describe, expect, it } from "vitest";
import { modelKey } from "./model-key.js";

describe("modelKey", () => {
  it("returns the model alone when provider is empty", () => {
    expect(modelKey("   ", "gpt-5")).toBe("gpt-5");
  });

  it("returns the provider alone when model is empty", () => {
    expect(modelKey("openai", "   ")).toBe("openai");
  });

  it("avoids double prefix when model already contains provider prefix", () => {
    expect(modelKey("openai", "openai/gpt-5")).toBe("openai/gpt-5");
  });

  it("trims whitespace from both arguments", () => {
    expect(modelKey(" openai ", " gpt-5 ")).toBe("openai/gpt-5");
  });
});
