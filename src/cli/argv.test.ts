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
      argv: ["node", "evox", "--help"],
      expected: true,
    },
    {
      name: "version flag",
      argv: ["node", "evox", "-V"],
      expected: true,
    },
    {
      name: "normal command",
      argv: ["node", "evox", "status"],
      expected: false,
    },
    {
      name: "root -v alias",
      argv: ["node", "evox", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "evox", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with log-level",
      argv: ["node", "evox", "--log-level", "debug", "-v"],
      expected: true,
    },
    {
      name: "subcommand -v should not be treated as version",
      argv: ["node", "evox", "acp", "-v"],
      expected: false,
    },
    {
      name: "root -v alias with equals profile",
      argv: ["node", "evox", "--profile=work", "-v"],
      expected: true,
    },
    {
      name: "subcommand path after global root flags should not be treated as version",
      argv: ["node", "evox", "--dev", "skills", "list", "-v"],
      expected: false,
    },
  ])("detects help/version flags: $name", ({ argv, expected }) => {
    expect(hasHelpOrVersion(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --version",
      argv: ["node", "evox", "--version"],
      expected: true,
    },
    {
      name: "root -V",
      argv: ["node", "evox", "-V"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "evox", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "subcommand version flag",
      argv: ["node", "evox", "status", "--version"],
      expected: false,
    },
    {
      name: "unknown root flag with version",
      argv: ["node", "evox", "--unknown", "--version"],
      expected: false,
    },
  ])("detects root-only version invocations: $name", ({ argv, expected }) => {
    expect(isRootVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --help",
      argv: ["node", "evox", "--help"],
      expected: true,
    },
    {
      name: "root -h",
      argv: ["node", "evox", "-h"],
      expected: true,
    },
    {
      name: "root --help with profile",
      argv: ["node", "evox", "--profile", "work", "--help"],
      expected: true,
    },
    {
      name: "subcommand --help",
      argv: ["node", "evox", "status", "--help"],
      expected: false,
    },
    {
      name: "help before subcommand token",
      argv: ["node", "evox", "--help", "status"],
      expected: false,
    },
    {
      name: "help after -- terminator",
      argv: ["node", "evox", "nodes", "run", "--", "git", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag before help",
      argv: ["node", "evox", "--unknown", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag after help",
      argv: ["node", "evox", "--help", "--unknown"],
      expected: false,
    },
  ])("detects root-only help invocations: $name", ({ argv, expected }) => {
    expect(isRootHelpInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "evox", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "evox", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "evox", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPath(argv, 2)).toEqual(expected);
  });

  it("extracts command path while skipping known root option values", () => {
    expect(
      getCommandPathWithRootOptions(
        ["node", "evox", "--profile", "work", "--no-color", "config", "validate"],
        2,
      ),
    ).toEqual(["config", "validate"]);
  });

  it("extracts routed config get positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "evox", "config", "get", "--log-level", "debug", "update.channel", "--json"],
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
        ["node", "evox", "config", "unset", "--profile", "work", "update.channel"],
        {
          commandPath: ["config", "unset"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("returns null when routed command sees unknown options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "evox", "config", "get", "--mystery", "value", "update.channel"],
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
      argv: ["node", "evox", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "evox"],
      expected: null,
    },
    {
      name: "skips known root option values",
      argv: ["node", "evox", "--log-level", "debug", "status"],
      expected: "status",
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "evox", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "evox", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "evox", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "evox", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "evox", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "evox", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "evox", "--", "--timeout=99"],
      expected: undefined,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "evox", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "evox", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "evox", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "evox", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "evox", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "evox", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "evox", "status", "--timeout", "nope"],
      expected: undefined,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("builds parse argv from raw args", () => {
    const cases = [
      {
        rawArgs: ["node", "evox", "status"],
        expected: ["node", "evox", "status"],
      },
      {
        rawArgs: ["node-22", "evox", "status"],
        expected: ["node-22", "evox", "status"],
      },
      {
        rawArgs: ["node-22.2.0.exe", "evox", "status"],
        expected: ["node-22.2.0.exe", "evox", "status"],
      },
      {
        rawArgs: ["node-22.2", "evox", "status"],
        expected: ["node-22.2", "evox", "status"],
      },
      {
        rawArgs: ["node-22.2.exe", "evox", "status"],
        expected: ["node-22.2.exe", "evox", "status"],
      },
      {
        rawArgs: ["/usr/bin/node-22.2.0", "evox", "status"],
        expected: ["/usr/bin/node-22.2.0", "evox", "status"],
      },
      {
        rawArgs: ["node24", "evox", "status"],
        expected: ["node24", "evox", "status"],
      },
      {
        rawArgs: ["/usr/bin/node24", "evox", "status"],
        expected: ["/usr/bin/node24", "evox", "status"],
      },
      {
        rawArgs: ["node24.exe", "evox", "status"],
        expected: ["node24.exe", "evox", "status"],
      },
      {
        rawArgs: ["nodejs", "evox", "status"],
        expected: ["nodejs", "evox", "status"],
      },
      {
        rawArgs: ["node-dev", "evox", "status"],
        expected: ["node", "evox", "node-dev", "evox", "status"],
      },
      {
        rawArgs: ["evox", "status"],
        expected: ["node", "evox", "status"],
      },
      {
        rawArgs: ["bun", "src/entry.ts", "status"],
        expected: ["bun", "src/entry.ts", "status"],
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = buildParseArgv({
        programName: "evox",
        rawArgs: [...testCase.rawArgs],
      });
      expect(parsed).toEqual([...testCase.expected]);
    }
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "evox",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "evox", "status"]);
  });

  it("decides when to migrate state", () => {
    const nonMutatingArgv = [
      ["node", "evox", "status"],
      ["node", "evox", "health"],
      ["node", "evox", "sessions"],
      ["node", "evox", "config", "get", "update"],
      ["node", "evox", "config", "unset", "update"],
      ["node", "evox", "models", "list"],
      ["node", "evox", "models", "status"],
      ["node", "evox", "memory", "status"],
      ["node", "evox", "update", "status", "--json"],
      ["node", "evox", "agent", "--message", "hi"],
    ] as const;
    const mutatingArgv = [
      ["node", "evox", "agents", "list"],
      ["node", "evox", "message", "send"],
    ] as const;

    for (const argv of nonMutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(false);
    }
    for (const argv of mutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(true);
    }
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
