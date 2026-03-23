import { describe, expect, it } from "vitest";
import { tokenizedOptionFilter } from "./clack-prompter.js";

describe("tokenizedOptionFilter", () => {
  it("matches tokens regardless of order", () => {
    const option = {
      value: "openai/gpt-5.2",
      label: "openai/gpt-5.2",
      hint: "ctx 400k",
    };

    expect(tokenizedOptionFilter("gpt-5.2 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.2", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    const option = {
      value: "openai/gpt-5.2",
      label: "openai/gpt-5.2",
    };

    expect(tokenizedOptionFilter("gpt-5.2 anthropic/", option)).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    const option = {
      value: "openai/gpt-5.2",
      label: "GPT 5.2",
      hint: "provider openai",
    };

    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.2", option)).toBe(true);
  });
});
