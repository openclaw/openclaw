import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    {
      name: "help flag",
      argv: ["node", "activi", "--help"],
      expected: true,
    },
    {
      name: "version flag",
      argv: ["node", "activi", "-V"],
      expected: true,
    },
    {
      name: "normal command",
      argv: ["node", "activi", "status"],
      expected: false,
    },
    {
      name: "root -v alias",
      argv: ["node", "activi", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "activi", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with log-level",
      argv: ["node", "activi", "--log-level", "debug", "-v"],
      expected: true,
    },
    {
      name: "subcommand -v should not be treated as version",
      argv: ["node", "activi", "acp", "-v"],
      expected: false,
    },
    {
      name: "root -v alias with equals profile",
      argv: ["node", "activi", "--profile=work", "-v"],
      expected: true,
    },
    {
      name: "subcommand path after global root flags should not be treated as version",
      argv: ["node", "activi", "--dev", "skills", "list", "-v"],
      expected: false,
    },
  ])("detects help/version flags: $name", ({ argv, expected }) => {
    expect(hasHelpOrVersion(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "activi", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "activi", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "activi", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPath(argv, 2)).toEqual(expected);
  });

  it.each([
    {
      name: "returns first command token",
      argv: ["node", "activi", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "activi"],
      expected: null,
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "activi", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "activi", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "activi", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "activi", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "activi", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "activi", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "activi", "--", "--timeout=99"],
      expected: undefined,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "activi", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "activi", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "activi", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "activi", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "activi", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "activi", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "activi", "status", "--timeout", "nope"],
      expected: undefined,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("builds parse argv from raw args", () => {
    const cases = [
      {
        rawArgs: ["node", "activi", "status"],
        expected: ["node", "activi", "status"],
      },
      {
        rawArgs: ["node-22", "activi", "status"],
        expected: ["node-22", "activi", "status"],
      },
      {
        rawArgs: ["node-22.2.0.exe", "activi", "status"],
        expected: ["node-22.2.0.exe", "activi", "status"],
      },
      {
        rawArgs: ["node-22.2", "activi", "status"],
        expected: ["node-22.2", "activi", "status"],
      },
      {
        rawArgs: ["node-22.2.exe", "activi", "status"],
        expected: ["node-22.2.exe", "activi", "status"],
      },
      {
        rawArgs: ["/usr/bin/node-22.2.0", "activi", "status"],
        expected: ["/usr/bin/node-22.2.0", "activi", "status"],
      },
      {
        rawArgs: ["nodejs", "activi", "status"],
        expected: ["nodejs", "activi", "status"],
      },
      {
        rawArgs: ["node-dev", "activi", "status"],
        expected: ["node", "activi", "node-dev", "activi", "status"],
      },
      {
        rawArgs: ["activi", "status"],
        expected: ["node", "activi", "status"],
      },
      {
        rawArgs: ["bun", "src/entry.ts", "status"],
        expected: ["bun", "src/entry.ts", "status"],
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = buildParseArgv({
        programName: "activi",
        rawArgs: [...testCase.rawArgs],
      });
      expect(parsed).toEqual([...testCase.expected]);
    }
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "activi",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "activi", "status"]);
  });

  it("decides when to migrate state", () => {
    const nonMutatingArgv = [
      ["node", "activi", "status"],
      ["node", "activi", "health"],
      ["node", "activi", "sessions"],
      ["node", "activi", "config", "get", "update"],
      ["node", "activi", "config", "unset", "update"],
      ["node", "activi", "models", "list"],
      ["node", "activi", "models", "status"],
      ["node", "activi", "memory", "status"],
      ["node", "activi", "agent", "--message", "hi"],
    ] as const;
    const mutatingArgv = [
      ["node", "activi", "agents", "list"],
      ["node", "activi", "message", "send"],
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
    { path: ["config", "get"], expected: false },
    { path: ["models", "status"], expected: false },
    { path: ["agents", "list"], expected: true },
  ])("reuses command path for migrate state decisions: $path", ({ path, expected }) => {
    expect(shouldMigrateStateFromPath(path)).toBe(expected);
  });
});
