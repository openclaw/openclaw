import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  assertNonDestructiveReplacement,
  mergeAtPath,
  parseConfigSetPath,
  parseConfigSetValue,
} from "./config-cli-path.js";

function nestedRecord(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

describe("parseConfigSetValue", () => {
  it.each([
    { raw: "42", expected: 42 },
    { raw: "3.14", expected: 3.14 },
    { raw: "-0", expected: -0 },
    { raw: "true", expected: true },
    { raw: "false", expected: false },
    { raw: "null", expected: null },
    { raw: "{a:1}", expected: { a: 1 } },
    { raw: "[1,2]", expected: [1, 2] },
  ])("parses $raw as expected", ({ raw, expected }) => {
    expect(parseConfigSetValue(raw, false)).toEqual(expected);
  });

  it("falls back to the raw string when JSON5 parsing fails", () => {
    expect(parseConfigSetValue("hello", false)).toBe("hello");
  });

  it.each([
    { raw: "Infinity", label: "Infinity" },
    { raw: "-Infinity", label: "negative Infinity" },
    { raw: "NaN", label: "NaN" },
    { raw: "1e999", label: "overflow exponent" },
    { raw: "{timeout:1e999}", label: "object with overflow exponent" },
    { raw: "[1e999]", label: "array with overflow exponent" },
  ])("rejects $label in value mode", ({ raw }) => {
    expect(() => parseConfigSetValue(raw, false)).toThrow("Value must be a finite number");
  });

  it("rejects overflow exponent in strict JSON mode with the finite-number error", () => {
    expect(() => parseConfigSetValue("1e999", true)).toThrow("Value must be a finite number");
  });

  it.each([
    { raw: "Infinity", label: "Infinity" },
    { raw: "-Infinity", label: "negative Infinity" },
    { raw: "NaN", label: "NaN" },
  ])("rejects $label in strict JSON mode as invalid JSON", ({ raw }) => {
    expect(() => parseConfigSetValue(raw, true)).toThrow();
  });

  it("still reports JSON parse errors in strict JSON mode", () => {
    expect(() => parseConfigSetValue("not-json", true)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Could not parse "not-json" as JSON for --strict-json.'),
        cause: expect.any(SyntaxError),
      }),
    );
  });

  it("merges deeply nested object values without an engine failure", () => {
    const depth = 20_000;
    const root = { value: nestedRecord(depth, { retained: true }) };

    mergeAtPath(root, ["value"], nestedRecord(depth, { added: true }));

    let cursor: unknown = root.value;
    for (let index = 0; index < depth; index += 1) {
      if (!isRecord(cursor)) {
        throw new Error(`missing nested record at depth ${index}`);
      }
      cursor = cursor.nested;
    }
    expect(cursor).toEqual({ retained: true, added: true });
  });
});

// Each subcommand may only be pointed at the flags it registers; `config patch` has no
// --merge/--replace, so advice naming them strands the user.
describe("replacement guard advice", () => {
  const root = {
    agents: { defaults: { models: { "openai/gpt-5.4": { alias: "GPT" } } } },
    models: {
      providers: {
        ollama: { models: [{ id: "llama3.2" }, { id: "qwen3" }] },
        "local.service": { models: [{ id: "llama3.1:70b" }, { id: "qwen3:8b" }] },
        "local]service": { models: [{ id: "llama3.1:70b" }, { id: "qwen3:8b" }] },
        "it's": { models: [{ id: "llama3.1:70b" }, { id: "qwen3:8b" }] },
      },
    },
  } as Record<string, unknown>;

  function refusal(run: () => void): string {
    try {
      run();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected the replacement guard to refuse");
  }

  function requireReplacePathArgument(message: string): string {
    const argument = /--replace-path (\S+) to replace/.exec(message)?.[1];
    if (!argument) {
      throw new Error(`refusal names no --replace-path argument: ${message}`);
    }
    return argument;
  }

  /** Delivers one argument the way a shell does: quoted spans are literal, `'\''` splices a quote. */
  function readShellArgument(token: string): string {
    let value = "";
    for (let index = 0; index < token.length; index += 1) {
      const character = token[index];
      if (character === "'") {
        const close = token.indexOf("'", index + 1);
        if (close === -1) {
          throw new Error(`advice left an unbalanced quote: ${token}`);
        }
        value += token.slice(index + 1, close);
        index = close;
      } else if (character === "\\") {
        value += token[index + 1];
        index += 1;
      } else {
        value += character;
      }
    }
    return value;
  }

  it.each([
    {
      command: "patch" as const,
      advice: "Use --replace-path models.providers.ollama.models to replace intentionally.",
    },
    {
      command: "set" as const,
      advice: "Use --merge to merge by id or --replace to replace intentionally.",
    },
  ])("refuses a protected model list for config $command", ({ command, advice }) => {
    expect(
      refusal(() =>
        assertNonDestructiveReplacement({
          root,
          path: ["models", "providers", "ollama", "models"],
          value: [{ id: "llama3.2" }],
          command,
        }),
      ),
    ).toBe(
      `Refusing to replace models.providers.ollama.models; it would remove existing entries: qwen3. ${advice}`,
    );
  });

  it("points a protected model map refusal at the patch path flag", () => {
    expect(
      refusal(() =>
        assertNonDestructiveReplacement({
          root,
          path: ["agents", "defaults", "models"],
          value: { "anthropic/claude-sonnet-4-6": {} },
          command: "patch",
        }),
      ),
    ).toContain("Use --replace-path agents.defaults.models to replace intentionally.");
  });

  it.each([
    { command: "patch" as const, flag: "--replace-path models.providers.ollama.models" },
    { command: "set" as const, flag: "--replace" },
  ])("names a $command flag when a merge cannot apply", ({ command, flag }) => {
    expect(() =>
      mergeAtPath(root, ["models", "providers", "ollama", "models"], {}, { command }),
    ).toThrow(`Cannot merge models.providers.ollama.models; use ${flag} to replace intentionally.`);
  });

  it.each([
    {
      key: "local.service",
      argument: 'models.providers["local.service"].models',
      token: `'models.providers["local.service"].models'`,
    },
    {
      key: "local]service",
      argument: 'models.providers["local]service"].models',
      token: `'models.providers["local]service"].models'`,
    },
    {
      key: "it's",
      argument: `models.providers["it's"].models`,
      token: `'models.providers["it'\\''s"].models'`,
    },
  ])("suggests a $key retry that survives the shell", ({ key, argument, token }) => {
    const path = ["models", "providers", key, "models"];
    const guardArgument = requireReplacePathArgument(
      refusal(() =>
        assertNonDestructiveReplacement({
          root,
          path,
          value: [{ id: "qwen3:8b" }],
          command: "patch",
        }),
      ),
    );
    expect(guardArgument).toBe(token);
    expect(readShellArgument(guardArgument)).toBe(argument);
    expect(parseConfigSetPath(readShellArgument(guardArgument))).toEqual(path);
    expect(
      readShellArgument(
        requireReplacePathArgument(
          refusal(() => mergeAtPath(root, path, {}, { command: "patch" })),
        ),
      ),
    ).toBe(argument);
  });

  it("strands a bare retry whose key contains a closing bracket", () => {
    // What the shell hands the CLI once it strips the inner quotes of the bare bracketed form.
    expect(() => parseConfigSetPath("models.providers[local]service].models")).toThrow(
      "Invalid path (missing separator after bracket): models.providers[local]service].models",
    );
  });
});
