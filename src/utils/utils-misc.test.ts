import { describe, expect, it } from "vitest";
import { parseBooleanValue } from "./boolean.js";
import { isReasoningTagProvider } from "./provider-utils.js";
import { splitShellArgs } from "./shell-argv.js";

describe("parseBooleanValue", () => {
  it("handles boolean inputs", () => {
    expect(parseBooleanValue(true)).toBe(true);
    expect(parseBooleanValue(false)).toBe(false);
  });

  it("parses default truthy/falsy strings", () => {
    expect(parseBooleanValue("true")).toBe(true);
    expect(parseBooleanValue("1")).toBe(true);
    expect(parseBooleanValue("yes")).toBe(true);
    expect(parseBooleanValue("on")).toBe(true);
    expect(parseBooleanValue("false")).toBe(false);
    expect(parseBooleanValue("0")).toBe(false);
    expect(parseBooleanValue("no")).toBe(false);
    expect(parseBooleanValue("off")).toBe(false);
  });

  it("respects custom truthy/falsy lists", () => {
    expect(
      parseBooleanValue("on", {
        truthy: ["true"],
        falsy: ["false"],
      }),
    ).toBeUndefined();
    expect(
      parseBooleanValue("yes", {
        truthy: ["yes"],
        falsy: ["no"],
      }),
    ).toBe(true);
  });

  it("returns undefined for unsupported values", () => {
    expect(parseBooleanValue("")).toBeUndefined();
    expect(parseBooleanValue("maybe")).toBeUndefined();
    expect(parseBooleanValue(1)).toBeUndefined();
  });
});

describe("isReasoningTagProvider", () => {
  const cases: Array<{
    name: string;
    value: string | null | undefined;
    expected: boolean;
  }> = [
    {
      name: "returns false for ollama - native reasoning field, no tags needed (#2279)",
      value: "ollama",
      expected: false,
    },
    {
      name: "returns false for case-insensitive ollama",
      value: "Ollama",
      expected: false,
    },
    { name: "returns true for google-gemini-cli", value: "google-gemini-cli", expected: true },
    {
      name: "returns true for google-generative-ai",
      value: "google-generative-ai",
      expected: true,
    },
    { name: "returns true for google-antigravity", value: "google-antigravity", expected: true },
    {
      name: "returns true for google-antigravity model suffixes",
      value: "google-antigravity/gemini-3",
      expected: true,
    },
    { name: "returns true for minimax", value: "minimax", expected: true },
    { name: "returns true for minimax-cn", value: "minimax-cn", expected: true },
    { name: "returns false for null", value: null, expected: false },
    { name: "returns false for undefined", value: undefined, expected: false },
    { name: "returns false for empty", value: "", expected: false },
    { name: "returns false for anthropic", value: "anthropic", expected: false },
    { name: "returns false for openai", value: "openai", expected: false },
    { name: "returns false for openrouter", value: "openrouter", expected: false },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(isReasoningTagProvider(testCase.value)).toBe(testCase.expected);
    });
  }
});

describe("splitShellArgs", () => {
  it("splits whitespace and respects quotes", () => {
    expect(splitShellArgs(`qmd --foo "bar baz"`)).toEqual(["qmd", "--foo", "bar baz"]);
    expect(splitShellArgs(`qmd --foo 'bar baz'`)).toEqual(["qmd", "--foo", "bar baz"]);
  });

  it("supports backslash escapes inside double quotes", () => {
    expect(splitShellArgs(String.raw`echo "a\"b"`)).toEqual(["echo", `a"b`]);
    expect(splitShellArgs(String.raw`echo "\$HOME"`)).toEqual(["echo", "$HOME"]);
  });

  it("returns null for unterminated quotes", () => {
    expect(splitShellArgs(`echo "oops`)).toBeNull();
    expect(splitShellArgs(`echo 'oops`)).toBeNull();
  });
});
