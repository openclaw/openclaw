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
  it("returns false for ollama - native reasoning field, no tags needed (#2279)", () => {
    expect(isReasoningTagProvider("ollama")).toBe(false);
    expect(isReasoningTagProvider("Ollama")).toBe(false);
  });

  it("returns true for google-gemini-cli", () => {
    expect(isReasoningTagProvider("google-gemini-cli")).toBe(true);
  });

  it("returns true for google-generative-ai", () => {
    expect(isReasoningTagProvider("google-generative-ai")).toBe(true);
  });

  it("returns true for google-antigravity", () => {
    expect(isReasoningTagProvider("google-antigravity")).toBe(true);
    expect(isReasoningTagProvider("google-antigravity/gemini-3")).toBe(true);
  });

  it("returns true for minimax", () => {
    expect(isReasoningTagProvider("minimax")).toBe(true);
    expect(isReasoningTagProvider("minimax-cn")).toBe(true);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isReasoningTagProvider(null)).toBe(false);
    expect(isReasoningTagProvider(undefined)).toBe(false);
    expect(isReasoningTagProvider("")).toBe(false);
  });

  it("returns false for standard providers", () => {
    expect(isReasoningTagProvider("anthropic")).toBe(false);
    expect(isReasoningTagProvider("openai")).toBe(false);
    expect(isReasoningTagProvider("openrouter")).toBe(false);
  });
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

  it("returns null for trailing escape", () => {
    expect(splitShellArgs("foo bar\\")).toBeNull();
  });

  it("handles multiple and leading/trailing spaces", () => {
    expect(splitShellArgs("foo   bar    baz")).toEqual(["foo", "bar", "baz"]);
    expect(splitShellArgs("  foo bar  ")).toEqual(["foo", "bar"]);
  });

  it("handles escaped spaces outside quotes", () => {
    expect(splitShellArgs("foo bar\\ baz qux")).toEqual(["foo", "bar baz", "qux"]);
  });

  it("handles adjacent quoted and unquoted parts", () => {
    expect(splitShellArgs('pre"quoted"post')).toEqual(["prequotedpost"]);
  });

  it("handles empty and whitespace-only input", () => {
    expect(splitShellArgs("")).toEqual([]);
    expect(splitShellArgs("   ")).toEqual([]);
  });

  it("handles quotes inside quotes (different type)", () => {
    expect(splitShellArgs(`foo "it's working" bar`)).toEqual(["foo", "it's working", "bar"]);
    expect(splitShellArgs(`foo 'he said "hello"' bar`)).toEqual(["foo", 'he said "hello"', "bar"]);
  });

  it("handles paths with spaces in quotes", () => {
    expect(splitShellArgs('cmd "/path/with spaces/file.txt"')).toEqual([
      "cmd",
      "/path/with spaces/file.txt",
    ]);
  });

  it("handles unicode characters", () => {
    expect(splitShellArgs("echo 'héllo wörld' 日本語")).toEqual(["echo", "héllo wörld", "日本語"]);
  });

  it("handles tabs and newlines as whitespace", () => {
    expect(splitShellArgs("foo\tbar\tbaz")).toEqual(["foo", "bar", "baz"]);
    expect(splitShellArgs("foo\nbar")).toEqual(["foo", "bar"]);
  });
});
