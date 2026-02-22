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
      argv: ["node", "openclaw", "--help"],
      expected: true,
    },
    {
      name: "version flag",
      argv: ["node", "openclaw", "-V"],
      expected: true,
    },
    {
      name: "normal command",
      argv: ["node", "openclaw", "status"],
      expected: false,
    },
    {
      name: "root -v alias",
      argv: ["node", "openclaw", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "openclaw", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with log-level",
      argv: ["node", "openclaw", "--log-level", "debug", "-v"],
      expected: true,
    },
    {
      name: "subcommand -v should not be treated as version",
      argv: ["node", "openclaw", "acp", "-v"],
      expected: false,
    },
    {
      name: "root -v alias with equals profile",
      argv: ["node", "openclaw", "--profile=work", "-v"],
      expected: true,
    },
    {
      name: "subcommand path after global root flags should not be treated as version",
      argv: ["node", "openclaw", "--dev", "skills", "list", "-v"],
      expected: false,
    },
  ])("detects help/version flags: $name", ({ argv, expected }) => {
    expect(hasHelpOrVersion(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "openclaw", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "openclaw", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "openclaw", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPath(argv, 2)).toEqual(expected);
  });

  it.each([
    {
      name: "returns first command token",
      argv: ["node", "openclaw", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "openclaw"],
      expected: null,
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "openclaw", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "openclaw", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "openclaw", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "openclaw", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "openclaw", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "openclaw", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "openclaw", "--", "--timeout=99"],
      expected: undefined,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "openclaw", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "openclaw", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "openclaw", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "openclaw", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "openclaw", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "openclaw", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "openclaw", "status", "--timeout", "nope"],
      expected: undefined,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("builds parse argv from raw args", () => {
    const cases = [
      {
        rawArgs: ["node", "openclaw", "status"],
        expected: ["node", "openclaw", "status"],
      },
      {
        rawArgs: ["node-22", "openclaw", "status"],
        expected: ["node-22", "openclaw", "status"],
      },
      {
        rawArgs: ["node-22.2.0.exe", "openclaw", "status"],
        expected: ["node-22.2.0.exe", "openclaw", "status"],
      },
      {
        rawArgs: ["node-22.2", "openclaw", "status"],
        expected: ["node-22.2", "openclaw", "status"],
      },
      {
        rawArgs: ["node-22.2.exe", "openclaw", "status"],
        expected: ["node-22.2.exe", "openclaw", "status"],
      },
      {
        rawArgs: ["/usr/bin/node-22.2.0", "openclaw", "status"],
        expected: ["/usr/bin/node-22.2.0", "openclaw", "status"],
      },
      {
        rawArgs: ["nodejs", "openclaw", "status"],
        expected: ["nodejs", "openclaw", "status"],
      },
      {
        rawArgs: ["node-dev", "openclaw", "status"],
        expected: ["node", "openclaw", "node-dev", "openclaw", "status"],
      },
      {
        rawArgs: ["openclaw", "status"],
        expected: ["node", "openclaw", "status"],
      },
      {
        rawArgs: ["bun", "src/entry.ts", "status"],
        expected: ["bun", "src/entry.ts", "status"],
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = buildParseArgv({
        programName: "openclaw",
        rawArgs: [...testCase.rawArgs],
      });
      expect(parsed).toEqual([...testCase.expected]);
    }
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "openclaw",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "openclaw", "status"]);
  });

  it("decides when to migrate state", () => {
    const nonMutatingArgv = [
      ["node", "openclaw", "status"],
      ["node", "openclaw", "health"],
      ["node", "openclaw", "sessions"],
      ["node", "openclaw", "config", "get", "update"],
      ["node", "openclaw", "config", "unset", "update"],
      ["node", "openclaw", "models", "list"],
      ["node", "openclaw", "models", "status"],
      ["node", "openclaw", "memory", "status"],
      ["node", "openclaw", "agent", "--message", "hi"],
    ] as const;
    const mutatingArgv = [
      ["node", "openclaw", "agents", "list"],
      ["node", "openclaw", "message", "send"],
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
