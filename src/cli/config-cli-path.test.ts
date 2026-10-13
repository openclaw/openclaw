import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  assertNonDestructiveReplacement,
  mergeAtPath,
  parseConfigSetPath,
  parseConfigSetValue,
  setAtPath,
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
    { member: "fallbacks", value: ["backup"] },
    { member: "timeoutMs", value: 5000 },
  ])("does not promote unrelated plugin strings when setting $member", ({ member, value }) => {
    const root = { plugins: { entries: { demo: { config: { model: "opaque" } } } } };
    setAtPath(root, ["plugins", "entries", "demo", "config", "model", member], value);
    expect(root.plugins.entries.demo.config.model).toEqual({ [member]: value });
  });

  it.each([
    { raw: "1e999", label: "strict overflow exponent", strict: true },
    { raw: "1e999", label: "overflow exponent" },
    { raw: "{timeout:1e999}", label: "object with overflow exponent" },
    { raw: "[1e999]", label: "array with overflow exponent" },
  ])("rejects $label in value mode", ({ raw, strict = false }) => {
    expect(() => parseConfigSetValue(raw, strict)).toThrow("Value must be a finite number");
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
        "it‘s": { models: [{ id: "llama3.1:70b" }, { id: "qwen3:8b" }] },
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

  function replacePathArguments(message: string): string[] {
    return [...message.matchAll(/--replace-path (\S+)/g)].map((match) => match[1] ?? "");
  }

  /** Delivers one argument the way a POSIX shell does: quoted spans are literal, `'\''` splices a quote. */
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

  /** Delivers one argument the way PowerShell does: quoted spans are literal, `''` splices a quote. */
  function readPowerShellArgument(token: string): string {
    let value = "";
    let quoted = false;
    for (let index = 0; index < token.length; index += 1) {
      const character = token[index];
      if (character !== "'") {
        value += character;
      } else if (quoted && token[index + 1] === "'") {
        value += "'";
        index += 1;
      } else {
        quoted = !quoted;
      }
    }
    return value;
  }

  it.each([
    {
      command: "patch",
      path: ["models", "providers", "ollama", "models"],
      value: [{ id: "llama3.2" }],
      removed: "qwen3",
      advice: "Use --replace-path models.providers.ollama.models to replace intentionally.",
    },
    {
      command: "set",
      path: ["models", "providers", "ollama", "models"],
      value: [{ id: "llama3.2" }],
      removed: "qwen3",
      advice: "Use --merge to merge by id or --replace to replace intentionally.",
    },
    {
      command: "patch",
      path: ["agents", "defaults", "models"],
      value: { "anthropic/claude-sonnet-4-6": {} },
      removed: "openai/gpt-5.4",
      advice: "Use --replace-path agents.defaults.models to replace intentionally.",
    },
  ] satisfies {
    command: "set" | "patch";
    path: string[];
    value: unknown;
    removed: string;
    advice: string;
  }[])("refuses $path for config $command", ({ command, path, value, removed, advice }) => {
    expect(refusal(() => assertNonDestructiveReplacement({ root, path, value, command }))).toBe(
      `Refusing to replace ${path.join(".")}; it would remove existing entries: ${removed}. ${advice}`,
    );
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
  ])("suggests one $key retry that both shells deliver intact", ({ key, argument, token }) => {
    const path = ["models", "providers", key, "models"];
    const argumentsFromGuard = replacePathArguments(
      refusal(() =>
        assertNonDestructiveReplacement({
          root,
          path,
          value: [{ id: "qwen3:8b" }],
          command: "patch",
        }),
      ),
    );
    expect(argumentsFromGuard).toEqual([token]);
    // A quoted span with no apostrophe in it is literal in both conventions, so one token serves both.
    expect(readShellArgument(token)).toBe(argument);
    expect(readPowerShellArgument(token)).toBe(argument);
    expect(parseConfigSetPath(readShellArgument(token))).toEqual(path);
    if (key === "local]service") {
      expect(() => parseConfigSetPath("models.providers[local]service].models")).toThrow(
        "Invalid path (missing separator after bracket): models.providers[local]service].models",
      );
    }
    expect(
      replacePathArguments(refusal(() => mergeAtPath(root, path, {}, { command: "patch" }))),
    ).toEqual(argumentsFromGuard);
  });

  it("names each shell's own spelling when the key holds an apostrophe", () => {
    const path = ["models", "providers", "it's", "models"];
    const argument = `models.providers["it's"].models`;
    const advice = refusal(() =>
      assertNonDestructiveReplacement({
        root,
        path,
        value: [{ id: "qwen3:8b" }],
        command: "patch",
      }),
    );
    const [posix, powershell] = replacePathArguments(advice);
    expect(advice).toContain("in bash and zsh, or --replace-path");
    expect(advice).toContain("in PowerShell to replace intentionally.");
    expect(posix).toBe(`'models.providers["it'\\''s"].models'`);
    expect(powershell).toBe(`'models.providers["it''s"].models'`);
    expect(readShellArgument(posix ?? "")).toBe(argument);
    expect(readPowerShellArgument(powershell ?? "")).toBe(argument);
    expect(parseConfigSetPath(readShellArgument(posix ?? ""))).toEqual(path);
    expect(parseConfigSetPath(readPowerShellArgument(powershell ?? ""))).toEqual(path);
    // Copying either form into the other shell is what the two spellings exist to prevent.
    expect(readPowerShellArgument(posix ?? "")).not.toBe(argument);
    expect(readShellArgument(powershell ?? "")).not.toBe(argument);
  });

  it("names both spellings for a key holding a typographic quote", () => {
    // PowerShell ends a quoted span on its own delimiter class, not just on an ASCII apostrophe,
    // so the divergence test reads both owners' output instead of looking for one character.
    const path = ["models", "providers", "it\u2018s", "models"];
    const advice = refusal(() =>
      assertNonDestructiveReplacement({
        root,
        path,
        value: [{ id: "qwen3:8b" }],
        command: "patch",
      }),
    );
    const [posix, powershell] = replacePathArguments(advice);
    expect(posix).toBe(`'models.providers["it\u2018s"].models'`);
    expect(powershell).toBe(`'models.providers["it\u2018\u2018s"].models'`);
    expect(parseConfigSetPath(readShellArgument(posix ?? ""))).toEqual(path);
  });
});
