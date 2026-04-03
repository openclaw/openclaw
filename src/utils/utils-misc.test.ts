import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBooleanValue } from "./boolean.js";
import { splitShellArgs } from "./shell-argv.js";

const resolveProviderReasoningOutputModeWithPluginMock = vi.fn((params: { provider: string }) => {
  switch (params.provider.toLowerCase()) {
    case "google":
    case "google-gemini-cli":
    case "google-generative-ai":
    case "minimax":
    case "minimax-cn":
      return "tagged" as const;
    default:
      return undefined;
  }
});

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderReasoningOutputModeWithPlugin: (params: { provider: string }) =>
    resolveProviderReasoningOutputModeWithPluginMock(params),
}));

let isReasoningTagProvider: typeof import("./provider-utils.js").isReasoningTagProvider;

beforeAll(async () => {
  ({ isReasoningTagProvider } = await import("./provider-utils.js"));
});

beforeEach(() => {
  resolveProviderReasoningOutputModeWithPluginMock.mockClear();
});

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
  it.each([
    {
      name: "returns false for ollama when the provider plugin has no tagged override",
      value: "ollama",
      expected: false,
    },
    {
      name: "returns false for case-insensitive ollama",
      value: "Ollama",
      expected: false,
    },
    {
      name: "returns true for google via provider hook",
      value: "google",
      expected: true,
    },
    {
      name: "returns true for Google (case-insensitive)",
      value: "Google",
      expected: true,
    },
    {
      name: "returns true for google-gemini-cli via provider hook",
      value: "google-gemini-cli",
      expected: true,
    },
    {
      name: "returns true for google-generative-ai via provider hook",
      value: "google-generative-ai",
      expected: true,
    },
    { name: "returns true for minimax via provider hook", value: "minimax", expected: true },
    {
      name: "returns true for minimax-cn via provider hook alias",
      value: "minimax-cn",
      expected: true,
    },
    { name: "returns false for null", value: null, expected: false },
    { name: "returns false for undefined", value: undefined, expected: false },
    { name: "returns false for empty", value: "", expected: false },
    { name: "returns false for anthropic", value: "anthropic", expected: false },
    { name: "returns false for openai", value: "openai", expected: false },
    { name: "returns false for openrouter", value: "openrouter", expected: false },
  ] satisfies Array<{
    name: string;
    value: string | null | undefined;
    expected: boolean;
  }>)("$name", ({ value, expected }) => {
    expect(isReasoningTagProvider(value)).toBe(expected);
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

  it("stops at unquoted shell comments but keeps quoted hashes literal", () => {
    expect(splitShellArgs(`echo hi # comment && whoami`)).toEqual(["echo", "hi"]);
    expect(splitShellArgs(`echo "hi # still-literal"`)).toEqual(["echo", "hi # still-literal"]);
    expect(splitShellArgs(`echo hi#tail`)).toEqual(["echo", "hi#tail"]);
  });
});
