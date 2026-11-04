import { expect, it } from "vitest";
import * as cliArgv from "./argv.js";

const cli = (args: string) => ["node", "openclaw", ...args.split(" ")];

it.each([
  ["--profile work backup help -h", "--profile work backup help"],
  ["docs help --help"],
  ["plugins help list --help", "plugins list --help"],
  ["backup help -- --help"],
  ["plugins help -- list", "plugins list --help"],
  ["plugins help list -- --help"],
])("normalizes generated help commands: %s", (argv, expected = argv) => {
  expect(cliArgv.normalizeGeneratedHelpCommandArgv(cli(argv))).toEqual(cli(expected));
});

it.each([
  ["help --help"],
  ["help plugins list --help", "plugins list --help"],
  ["help plugins -- list", "plugins list --help"],
  ["help plugins list -- --profile work"],
])("normalizes root help targets: %s", (argv, expected = argv) => {
  expect(cliArgv.normalizeRootHelpTargetArgv(cli(argv))).toEqual(cli(expected));
});

it("allows final command metadata to lift no-color after boolean command flags", () => {
  expect(
    cliArgv.normalizeRootNoColorArgv(cli("doctor --lint --json --no-color"), {
      shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
        remainingArgs[noColorIndex - 1] === "--message",
    }),
  ).toEqual(cli("--no-color doctor --lint --json"));
});

it.each([
  ["doctor --log-level=trace --json", "--log-level=trace doctor --json"],
  ["--profile work doctor --log-level debug", "--profile work --log-level debug doctor"],
  ["agent --message --log-level debug"],
  ["nodes run -- --log-level debug"],
  ["doctor --log-level --json"],
])("normalizes root --log-level before command parsing: %s", (argv, expected = argv) => {
  expect(cliArgv.normalizeRootLogLevelArgv(cli(argv))).toEqual(cli(expected));
});

it("preserves log-level when final command metadata owns the option", () => {
  const argv = cli("plugin-cmd --log-level debug");

  expect(
    cliArgv.normalizeRootLogLevelArgv(argv, {
      shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
        remainingArgs[logLevelIndex] === "--log-level",
    }),
  ).toEqual(argv);
});

it.each([
  ["external-plugin tools help", true],
  ["agent --message help", false],
  ["nodes invoke -- help", false],
  ["-- help config", true],
  ["config -- help", true],
  ["--version", true],
] as const)("detects help/version invocations: %s", (argv, expected) => {
  expect(cliArgv.isHelpOrVersionInvocation(cli(argv))).toBe(expected);
});

it("detects root-only version invocations with a profile", () => {
  expect(cliArgv.isRootVersionInvocation(cli("--profile work -v"))).toBe(true);
});

it("limits simple help fast paths to root options, a command, and help", () => {
  const commands = new Set(["setup"]);
  expect(cliArgv.isSimpleCommandHelpInvocation(cli("--profile work setup --help"), commands)).toBe(
    true,
  );
  expect(cliArgv.isSimpleCommandHelpInvocation(cli("setup --workspace --help"), commands)).toBe(
    false,
  );
  expect(cliArgv.isSimpleCommandHelpInvocation(cli("setup --profile work --help"), commands)).toBe(
    false,
  );
  expect(cliArgv.isSimpleCommandHelpInvocation(cli("--help setup"), commands)).toBe(false);
});

it("returns null when routed command sees unknown options", () => {
  expect(
    cliArgv.getCommandPositionalsWithRootOptions(cli("config get --mystery value update.channel"), {
      commandPath: ["config", "get"],
      booleanFlags: ["--json"],
    }),
  ).toBeNull();
});

it("ignores boolean flags after the terminator", () => {
  expect(cliArgv.hasFlag(cli("-- --json"), "--json")).toBe(false);
});

it.each([
  ["-- --timeout=99", undefined],
  ["status --timeout 100 --timeout=200", "200"],
] as const)("extracts flag values: %s", (argv, expected) => {
  expect(cliArgv.getFlagValue(cli(argv), "--timeout")).toBe(expected);
});

it("parses verbose flags", () => {
  expect(cliArgv.getVerboseFlag(cli("status --verbose"))).toBe(true);
  expect(cliArgv.getVerboseFlag(cli("status --debug"))).toBe(true);
});

it.each(["status --timeout", "status --timeout 0"])("rejects invalid integer: %s", (argv) => {
  expect(cliArgv.getPositiveIntFlagValue(cli(argv), "--timeout")).toBeNull();
});

it.each([
  [["openclaw", "status"], cli("status")],
  [
    ["bun", "src/entry.ts", "status"],
    ["bun", "src/entry.ts", "status"],
  ],
] as const)("builds parse argv from raw args: %j", (rawArgs, expected) => {
  expect(cliArgv.buildParseArgv([...rawArgs])).toEqual([...expected]);
});
