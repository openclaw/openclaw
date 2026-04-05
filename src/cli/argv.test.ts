import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getCommandPositionalsWithRootOptions,
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  isRootHelpInvocation,
  isRootVersionInvocation,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    {
      name: "help flag",
      argv: ["node", "mullusi", "--help"],
      expected: true,
    },
    {
      name: "version flag",
      argv: ["node", "mullusi", "-V"],
      expected: true,
    },
    {
      name: "normal command",
      argv: ["node", "mullusi", "status"],
      expected: false,
    },
    {
      name: "root -v alias",
      argv: ["node", "mullusi", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "mullusi", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with log-level",
      argv: ["node", "mullusi", "--log-level", "debug", "-v"],
      expected: true,
    },
    {
      name: "subcommand -v should not be treated as version",
      argv: ["node", "mullusi", "acp", "-v"],
      expected: false,
    },
    {
      name: "root -v alias with equals profile",
      argv: ["node", "mullusi", "--profile=work", "-v"],
      expected: true,
    },
    {
      name: "subcommand path after global root flags should not be treated as version",
      argv: ["node", "mullusi", "--dev", "skills", "list", "-v"],
      expected: false,
    },
  ])("detects help/version flags: $name", ({ argv, expected }) => {
    expect(hasHelpOrVersion(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --version",
      argv: ["node", "mullusi", "--version"],
      expected: true,
    },
    {
      name: "root -V",
      argv: ["node", "mullusi", "-V"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "mullusi", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "subcommand version flag",
      argv: ["node", "mullusi", "status", "--version"],
      expected: false,
    },
    {
      name: "unknown root flag with version",
      argv: ["node", "mullusi", "--unknown", "--version"],
      expected: false,
    },
  ])("detects root-only version invocations: $name", ({ argv, expected }) => {
    expect(isRootVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --help",
      argv: ["node", "mullusi", "--help"],
      expected: true,
    },
    {
      name: "root -h",
      argv: ["node", "mullusi", "-h"],
      expected: true,
    },
    {
      name: "root --help with profile",
      argv: ["node", "mullusi", "--profile", "work", "--help"],
      expected: true,
    },
    {
      name: "subcommand --help",
      argv: ["node", "mullusi", "status", "--help"],
      expected: false,
    },
    {
      name: "help before subcommand token",
      argv: ["node", "mullusi", "--help", "status"],
      expected: false,
    },
    {
      name: "help after -- terminator",
      argv: ["node", "mullusi", "nodes", "invoke", "--", "device.status", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag before help",
      argv: ["node", "mullusi", "--unknown", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag after help",
      argv: ["node", "mullusi", "--help", "--unknown"],
      expected: false,
    },
  ])("detects root-only help invocations: $name", ({ argv, expected }) => {
    expect(isRootHelpInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "mullusi", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "mullusi", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "mullusi", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPath(argv, 2)).toEqual(expected);
  });

  it("extracts command path while skipping known root option values", () => {
    expect(
      getCommandPathWithRootOptions(
        [
          "node",
          "mullusi",
          "--profile",
          "work",
          "--container",
          "demo",
          "--no-color",
          "config",
          "validate",
        ],
        2,
      ),
    ).toEqual(["config", "validate"]);
  });

  it("extracts routed config get positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "mullusi", "config", "get", "--log-level", "debug", "update.channel", "--json"],
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("extracts routed config unset positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "mullusi", "config", "unset", "--profile", "work", "update.channel"],
        {
          commandPath: ["config", "unset"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("returns null when routed command sees unknown options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "mullusi", "config", "get", "--mystery", "value", "update.channel"],
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "returns first command token",
      argv: ["node", "mullusi", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "mullusi"],
      expected: null,
    },
    {
      name: "skips known root option values",
      argv: ["node", "mullusi", "--log-level", "debug", "status"],
      expected: "status",
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "mullusi", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "mullusi", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "mullusi", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "mullusi", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "mullusi", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "mullusi", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "mullusi", "--", "--timeout=99"],
      expected: undefined,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "mullusi", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "mullusi", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "mullusi", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "mullusi", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "mullusi", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "mullusi", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "mullusi", "status", "--timeout", "nope"],
      expected: undefined,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it.each([
    {
      name: "keeps plain node argv",
      rawArgs: ["node", "mullusi", "status"],
      expected: ["node", "mullusi", "status"],
    },
    {
      name: "keeps version-suffixed node binary",
      rawArgs: ["node-22", "mullusi", "status"],
      expected: ["node-22", "mullusi", "status"],
    },
    {
      name: "keeps windows versioned node exe",
      rawArgs: ["node-22.2.0.exe", "mullusi", "status"],
      expected: ["node-22.2.0.exe", "mullusi", "status"],
    },
    {
      name: "keeps dotted node binary",
      rawArgs: ["node-22.2", "mullusi", "status"],
      expected: ["node-22.2", "mullusi", "status"],
    },
    {
      name: "keeps dotted node exe",
      rawArgs: ["node-22.2.exe", "mullusi", "status"],
      expected: ["node-22.2.exe", "mullusi", "status"],
    },
    {
      name: "keeps absolute versioned node path",
      rawArgs: ["/usr/bin/node-22.2.0", "mullusi", "status"],
      expected: ["/usr/bin/node-22.2.0", "mullusi", "status"],
    },
    {
      name: "keeps node24 shorthand",
      rawArgs: ["node24", "mullusi", "status"],
      expected: ["node24", "mullusi", "status"],
    },
    {
      name: "keeps absolute node24 shorthand",
      rawArgs: ["/usr/bin/node24", "mullusi", "status"],
      expected: ["/usr/bin/node24", "mullusi", "status"],
    },
    {
      name: "keeps windows node24 exe",
      rawArgs: ["node24.exe", "mullusi", "status"],
      expected: ["node24.exe", "mullusi", "status"],
    },
    {
      name: "keeps nodejs binary",
      rawArgs: ["nodejs", "mullusi", "status"],
      expected: ["nodejs", "mullusi", "status"],
    },
    {
      name: "prefixes fallback when first arg is not a node launcher",
      rawArgs: ["node-dev", "mullusi", "status"],
      expected: ["node", "mullusi", "node-dev", "mullusi", "status"],
    },
    {
      name: "prefixes fallback when raw args start at program name",
      rawArgs: ["mullusi", "status"],
      expected: ["node", "mullusi", "status"],
    },
    {
      name: "keeps bun execution argv",
      rawArgs: ["bun", "src/entry.ts", "status"],
      expected: ["bun", "src/entry.ts", "status"],
    },
  ] as const)("builds parse argv from raw args: $name", ({ rawArgs, expected }) => {
    const parsed = buildParseArgv({
      programName: "mullusi",
      rawArgs: [...rawArgs],
    });
    expect(parsed).toEqual([...expected]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "mullusi",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "mullusi", "status"]);
  });

  it.each([
    { argv: ["node", "mullusi", "status"], expected: false },
    { argv: ["node", "mullusi", "health"], expected: false },
    { argv: ["node", "mullusi", "sessions"], expected: false },
    { argv: ["node", "mullusi", "config", "get", "update"], expected: false },
    { argv: ["node", "mullusi", "config", "unset", "update"], expected: false },
    { argv: ["node", "mullusi", "models", "list"], expected: false },
    { argv: ["node", "mullusi", "models", "status"], expected: false },
    { argv: ["node", "mullusi", "update", "status", "--json"], expected: false },
    { argv: ["node", "mullusi", "agent", "--message", "hi"], expected: false },
    { argv: ["node", "mullusi", "agents", "list"], expected: true },
    { argv: ["node", "mullusi", "message", "send"], expected: true },
  ] as const)("decides when to migrate state: $argv", ({ argv, expected }) => {
    expect(shouldMigrateState([...argv])).toBe(expected);
  });

  it.each([
    { path: ["status"], expected: false },
    { path: ["update", "status"], expected: false },
    { path: ["config", "get"], expected: false },
    { path: ["models", "status"], expected: false },
    { path: ["agents", "list"], expected: true },
  ])("reuses command path for migrate state decisions: $path", ({ path, expected }) => {
    expect(shouldMigrateStateFromPath(path)).toBe(expected);
  });
});
