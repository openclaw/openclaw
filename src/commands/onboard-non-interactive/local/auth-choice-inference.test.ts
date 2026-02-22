import { describe, expect, it } from "vitest";
import { inferAuthChoiceFromFlags } from "./auth-choice-inference.js";

describe("auth-choice-inference", () => {
  it("infers together-api-key when only togetherApiKey is set", () => {
    const result = inferAuthChoiceFromFlags({
      togetherApiKey: "sk-together-test",
    });
    expect(result.choice).toBe("together-api-key");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      optionKey: "togetherApiKey",
      authChoice: "together-api-key",
      label: "--together-api-key",
    });
  });

  it("infers huggingface-api-key when only huggingfaceApiKey is set", () => {
    const result = inferAuthChoiceFromFlags({
      huggingfaceApiKey: "hf-test-token",
    });
    expect(result.choice).toBe("huggingface-api-key");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      optionKey: "huggingfaceApiKey",
      authChoice: "huggingface-api-key",
      label: "--huggingface-api-key",
    });
  });

  it("returns first match when multiple API key flags are set", () => {
    const result = inferAuthChoiceFromFlags({
      togetherApiKey: "sk-together",
      huggingfaceApiKey: "hf-token",
    });
    expect(result.matches).toHaveLength(2);
    expect(result.choice).toBe(result.matches[0]?.authChoice);
  });

  it("returns no choice when no API key flags are set", () => {
    const result = inferAuthChoiceFromFlags({});
    expect(result.choice).toBeUndefined();
    expect(result.matches).toHaveLength(0);
  });

  it("ignores empty or whitespace-only key values", () => {
    expect(inferAuthChoiceFromFlags({ togetherApiKey: "" }).choice).toBeUndefined();
    expect(inferAuthChoiceFromFlags({ togetherApiKey: "  " }).choice).toBeUndefined();
  });
});
