// Argv tests cover CLI argument parsing helpers and platform-specific normalization.
import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPositionalsWithRootOptions,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
  isHelpOrVersionInvocation,
  isRootVersionInvocation,
  isSimpleCommandHelpInvocation,
  normalizeGeneratedHelpCommandArgv,
  normalizeRootHelpTargetArgv,
  normalizeRootLogLevelArgv,
  normalizeRootNoColorArgv,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    [
      "known command group help command short help flag",
      ["node", "openclaw", "--profile", "work", "backup", "help", "-h"],
      ["node", "openclaw", "--profile", "work", "backup", "help"],
    ],
    [
      "leaf positional help remains untouched",
      ["node", "openclaw", "docs", "help", "--help"],
      ["node", "openclaw", "docs", "help", "--help"],
    ],

    [
      "known command group help target help flag",
      ["node", "openclaw", "plugins", "help", "list", "--help"],
      ["node", "openclaw", "plugins", "list", "--help"],
    ],

    [
      "terminator help flag remains untouched",
      ["node", "openclaw", "backup", "help", "--", "--help"],
      ["node", "openclaw", "backup", "help", "--", "--help"],
    ],
  ])("normalizes generated help commands: %s", (_name, argv, expected) => {
    expect(normalizeGeneratedHelpCommandArgv(argv)).toEqual(expected);
  });

  it.each([
    [
      "root help self-help remains untouched",
      ["node", "openclaw", "help", "--help"],
      ["node", "openclaw", "help", "--help"],
    ],
    [
      "nested root help target with help flag",
      ["node", "openclaw", "help", "plugins", "list", "--help"],
      ["node", "openclaw", "plugins", "list", "--help"],
    ],
  ])("normalizes root help targets: %s", (_name, argv, expected) => {
    expect(normalizeRootHelpTargetArgv(argv)).toEqual(expected);
  });

  it("allows final command metadata to lift no-color after boolean command flags", () => {
    const argv = ["node", "openclaw", "doctor", "--lint", "--json", "--no-color"];

    expect(
      normalizeRootNoColorArgv(argv, {
        shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
          remainingArgs[noColorIndex - 1] === "--message",
      }),
    ).toEqual(["node", "openclaw", "--no-color", "doctor", "--lint", "--json"]);
  });

  it.each([
    [
      "subcommand trailing log-level equals form",
      ["node", "openclaw", "doctor", "--log-level=trace", "--json"],
      ["node", "openclaw", "--log-level=trace", "doctor", "--json"],
    ],
    [
      "keeps existing root options first",
      ["node", "openclaw", "--profile", "work", "doctor", "--log-level", "debug"],
      ["node", "openclaw", "--profile", "work", "--log-level", "debug", "doctor"],
    ],
    [
      "keeps log-level after possible command option value",
      ["node", "openclaw", "agent", "--message", "--log-level", "debug"],
      ["node", "openclaw", "agent", "--message", "--log-level", "debug"],
    ],
    [
      "flag terminator leaves log-level positional",
      ["node", "openclaw", "nodes", "run", "--", "--log-level", "debug"],
      ["node", "openclaw", "nodes", "run", "--", "--log-level", "debug"],
    ],
    [
      "missing value remains command scoped",
      ["node", "openclaw", "doctor", "--log-level", "--json"],
      ["node", "openclaw", "doctor", "--log-level", "--json"],
    ],
  ])("normalizes root --log-level before command parsing: %s", (_name, argv, expected) => {
    expect(normalizeRootLogLevelArgv(argv)).toEqual(expected);
  });

  it("preserves log-level when final command metadata owns the option", () => {
    const argv = ["node", "openclaw", "plugin-cmd", "--log-level", "debug"];

    expect(
      normalizeRootLogLevelArgv(argv, {
        shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
          remainingArgs[logLevelIndex] === "--log-level",
      }),
    ).toEqual(argv);
  });

  it.each([
    ["unknown plugin command help", ["node", "openclaw", "external-plugin", "tools", "help"], true],

    ["help as option value", ["node", "openclaw", "agent", "--message", "help"], false],
    ["help after terminator", ["node", "openclaw", "nodes", "invoke", "--", "help"], false],
    [
      "implicit root help command after terminator",
      ["node", "openclaw", "--", "help", "config"],
      true,
    ],
    [
      "implicit parent help command after terminator",
      ["node", "openclaw", "config", "--", "help"],
      true,
    ],

    ["root version flag", ["node", "openclaw", "--version"], true],
  ])("detects help/version invocations: %s", (_name, argv, expected) => {
    expect(isHelpOrVersionInvocation(argv)).toBe(expected);
  });

  it.each([["root -v alias with profile", ["node", "openclaw", "--profile", "work", "-v"], true]])(
    "detects root-only version invocations: %s",
    (_name, argv, expected) => {
      expect(isRootVersionInvocation(argv)).toBe(expected);
    },
  );

  it("limits simple help fast paths to root options, a command, and help", () => {
    const commands = new Set(["setup"]);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "openclaw", "--profile", "work", "setup", "--help"],
        commands,
      ),
    ).toBe(true);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "openclaw", "setup", "--workspace", "--help"],
        commands,
      ),
    ).toBe(false);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "openclaw", "setup", "--profile", "work", "--help"],
        commands,
      ),
    ).toBe(false);
    expect(isSimpleCommandHelpInvocation(["node", "openclaw", "--help", "setup"], commands)).toBe(
      false,
    );
  });

  it("returns null when routed command sees unknown options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "openclaw", "config", "get", "--mystery", "value", "update.channel"],
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toBeNull();
  });

  it.each([
    ["ignores flag after terminator", ["node", "openclaw", "--", "--json"], "--json", false],
  ])("parses boolean flags: %s", (_name, argv, flag, expected) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    ["flag appears after terminator", ["node", "openclaw", "--", "--timeout=99"], undefined],
    [
      "repeated flag uses final value",
      ["node", "openclaw", "status", "--timeout", "100", "--timeout=200"],
      "200",
    ],
  ])("extracts flag values: %s", (_name, argv, expected) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "openclaw", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "openclaw", "status", "--debug"])).toBe(true);
  });

  it.each([
    ["missing value", ["node", "openclaw", "status", "--timeout"], null],

    ["zero", ["node", "openclaw", "status", "--timeout", "0"], null],
  ])("parses positive integer flag values: %s", (_name, argv, expected) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it.each([
    [
      "prefixes fallback when raw args start at program name",
      ["openclaw", "status"],
      ["node", "openclaw", "status"],
    ],
    [
      "keeps bun execution argv",
      ["bun", "src/entry.ts", "status"],
      ["bun", "src/entry.ts", "status"],
    ],
  ] as const)("builds parse argv from raw args: %s", (_name, rawArgs, expected) => {
    const parsed = buildParseArgv([...rawArgs]);
    expect(parsed).toEqual([...expected]);
  });
});
