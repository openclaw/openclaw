import { expect, it } from "vitest";
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

const cli = (args: string) => ["node", "openclaw", ...args.split(" ")];

it.each([
  ["group short help", "--profile work backup help -h", "--profile work backup help"],
  ["leaf positional help", "docs help --help", "docs help --help"],
  ["group target help", "plugins help list --help", "plugins list --help"],
  ["terminator", "backup help -- --help", "backup help -- --help"],
])("normalizes generated help commands: %s", (_name, argv, expected) => {
  expect(normalizeGeneratedHelpCommandArgv(cli(argv))).toEqual(cli(expected));
});

it.each([
  ["self-help", "help --help", "help --help"],
  ["nested target", "help plugins list --help", "plugins list --help"],
])("normalizes root help targets: %s", (_name, argv, expected) => {
  expect(normalizeRootHelpTargetArgv(cli(argv))).toEqual(cli(expected));
});

it("allows final command metadata to lift no-color after boolean command flags", () => {
  const argv = cli("doctor --lint --json --no-color");

  expect(
    normalizeRootNoColorArgv(argv, {
      shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
        remainingArgs[noColorIndex - 1] === "--message",
    }),
  ).toEqual(cli("--no-color doctor --lint --json"));
});

it.each([
  ["equals", "doctor --log-level=trace --json", "--log-level=trace doctor --json"],
  [
    "root options first",
    "--profile work doctor --log-level debug",
    "--profile work --log-level debug doctor",
  ],
  [
    "command option value",
    "agent --message --log-level debug",
    "agent --message --log-level debug",
  ],
  ["terminator", "nodes run -- --log-level debug", "nodes run -- --log-level debug"],
  ["missing value", "doctor --log-level --json", "doctor --log-level --json"],
])("normalizes root --log-level before command parsing: %s", (_name, argv, expected) => {
  expect(normalizeRootLogLevelArgv(cli(argv))).toEqual(cli(expected));
});

it("preserves log-level when final command metadata owns the option", () => {
  const argv = cli("plugin-cmd --log-level debug");

  expect(
    normalizeRootLogLevelArgv(argv, {
      shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
        remainingArgs[logLevelIndex] === "--log-level",
    }),
  ).toEqual(argv);
});

it.each([
  ["unknown plugin command help", cli("external-plugin tools help"), true],
  ["help as option value", cli("agent --message help"), false],
  ["help after terminator", cli("nodes invoke -- help"), false],
  ["implicit root help command after terminator", cli("-- help config"), true],
  ["implicit parent help command after terminator", cli("config -- help"), true],
  ["root version flag", cli("--version"), true],
])("detects help/version invocations: %s", (_name, argv, expected) => {
  expect(isHelpOrVersionInvocation(argv)).toBe(expected);
});

it("detects root-only version invocations with a profile", () => {
  expect(isRootVersionInvocation(cli("--profile work -v"))).toBe(true);
});

it("limits simple help fast paths to root options, a command, and help", () => {
  const commands = new Set(["setup"]);
  expect(isSimpleCommandHelpInvocation(cli("--profile work setup --help"), commands)).toBe(true);
  expect(isSimpleCommandHelpInvocation(cli("setup --workspace --help"), commands)).toBe(false);
  expect(isSimpleCommandHelpInvocation(cli("setup --profile work --help"), commands)).toBe(false);
  expect(isSimpleCommandHelpInvocation(cli("--help setup"), commands)).toBe(false);
});

it("returns null when routed command sees unknown options", () => {
  expect(
    getCommandPositionalsWithRootOptions(cli("config get --mystery value update.channel"), {
      commandPath: ["config", "get"],
      booleanFlags: ["--json"],
    }),
  ).toBeNull();
});

it("ignores boolean flags after the terminator", () => {
  expect(hasFlag(cli("-- --json"), "--json")).toBe(false);
});

it.each([
  ["flag appears after terminator", cli("-- --timeout=99"), undefined],
  ["repeated flag uses final value", cli("status --timeout 100 --timeout=200"), "200"],
])("extracts flag values: %s", (_name, argv, expected) => {
  expect(getFlagValue(argv, "--timeout")).toBe(expected);
});

it("parses verbose flags", () => {
  expect(getVerboseFlag(cli("status --verbose"))).toBe(true);
  expect(getVerboseFlag(cli("status --debug"))).toBe(true);
});

it.each([
  ["missing value", cli("status --timeout"), null],
  ["zero", cli("status --timeout 0"), null],
])("parses positive integer flag values: %s", (_name, argv, expected) => {
  expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
});

it.each([
  ["prefixes fallback when raw args start at program name", ["openclaw", "status"], cli("status")],
  [
    "keeps bun execution argv",
    ["bun", "src/entry.ts", "status"],
    ["bun", "src/entry.ts", "status"],
  ],
] as const)("builds parse argv from raw args: %s", (_name, rawArgs, expected) => {
  const parsed = buildParseArgv([...rawArgs]);
  expect(parsed).toEqual([...expected]);
});
