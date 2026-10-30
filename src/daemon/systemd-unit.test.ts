import { expect, it } from "vitest";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  renderSystemdEnvAssignment,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

const values = ["plain", 'mix \\ and " here', "trailing\\", "apostrophe's", "'quoted'"];
const directives = (unit: string, key: string) =>
  unit
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
const execStart = (unit: string) => directives(unit, "ExecStart")[0] ?? "";
const build = (
  programArguments: string[],
  options: Omit<Parameters<typeof buildSystemdUnit>[0], "programArguments"> = {},
) => buildSystemdUnit({ programArguments, ...options });

const command = "ExecStart=run";
it.each([
  [`# \\\n; \\\n${command}`, ["# \\", "; \\", command]],
  ['Environment="X=1\\\n # \\\n ;\n  2"', ['Environment="X=1   2"']],
  [`Environment=X=1\\\\\n${command}`, ["Environment=X=1\\\\", command]],
  [`Environment=X=1\\\n\n${command}`, ["Environment=X=1 ", command]],
  ["Environment=X=1\\\n #", ["Environment=X=1 "]],
] as const)("preserves LF and CRLF boundaries in %j", (input, expected) => {
  for (const separator of ["\n", "\r\n"]) {
    expect(splitSystemdLogicalLines(input.replaceAll("\n", separator))).toEqual(expected);
  }
});

it("round-trips escaped and quoted Environment values", () => {
  for (const value of values) {
    expect(parseSystemdEnvAssignments(renderSystemdEnvAssignment("TOKEN", value))).toEqual([
      { key: "TOKEN", value },
    ]);
  }
});

it("round-trips escaped, quoted and empty ExecStart arguments without shifting positions", () => {
  const programArguments = ["run", "", ...values, "tail", ""];
  const unit = build(programArguments);
  expect(execStart(unit)).toBe(
    String.raw`run "" plain "mix \\ and \" here" "trailing\\" "apostrophe's" "'quoted'" tail ""`,
  );
  expect(parseSystemdExecStart(execStart(unit))).toEqual(programArguments);
});

it("preserves explicit NODE_OPTIONS while omitting other empty values", () => {
  for (const nodeOptions of ["", "--max-old-space-size=24576"]) {
    const programArguments = ["/usr/bin/node", "--max-old-space-size=16384", "gateway.js"];
    const unit = build(programArguments, {
      environment: { NODE_OPTIONS: nodeOptions, UNUSED: "", MISSING: undefined },
    });
    expect(directives(unit, "Environment").flatMap(parseSystemdEnvAssignments)).toEqual([
      { key: "NODE_OPTIONS", value: nodeOptions },
    ]);
  }
});

it("renders the gateway unit with safe lifecycle policy and ordered environment directives", () => {
  const unit = build(["/usr/bin/openclaw", "gateway", "--name", "My Bot"], {
    environmentFiles: ["/home/test/.openclaw/.env"],
    environment: { OPENCLAW_GATEWAY_PORT: "18789" },
  });
  expect(unit.split("\n")).toEqual(
    expect.arrayContaining([
      'ExecStart=/usr/bin/openclaw gateway --name "My Bot"',
      "KillMode=mixed",
      "TimeoutStopSec=330",
      "TimeoutStartSec=30",
      "SuccessExitStatus=0 143",
      "OOMPolicy=continue",
      "StartLimitBurst=10",
      "StartLimitIntervalSec=300",
      "RestartSec=5",
      "RestartPreventExitStatus=78",
      "EnvironmentFile=-/home/test/.openclaw/.env",
      "Environment=OPENCLAW_GATEWAY_PORT=18789",
    ]),
  );
  expect(unit.indexOf("EnvironmentFile=-/home/test/.openclaw/.env")).toBeLessThan(
    unit.indexOf("Environment=OPENCLAW_GATEWAY_PORT=18789"),
  );
});

it("rejects environment values with line breaks", () => {
  expect(() =>
    build(["/usr/bin/openclaw", "gateway", "start"], {
      environment: { INJECT: "ok\nExecStartPre=/bin/touch /tmp/oc15789_rce" },
    }),
  ).toThrow(/CR or LF/);
});

it.each([
  ['run "a b"', "none", ["run", "a b"]],
  ['run "C:\\\\a b\\\\c"', "backslash-quote-only", ["run", "C:\\\\a b\\\\c"]],
  ['run "a \\"b\\" c"', "backslash-quote-only", ["run", 'a "b" c']],
  ['  "" run "" tail ""  ', "none", ["", "run", "", "tail", ""]],
  ['  "" run "" tail ""  ', "backslash-quote-only", ["", "run", "", "tail", ""]],
] as const)("splits %s using %s escaping", (input, escapeMode, expected) => {
  expect(
    splitArgsPreservingQuotes(input, escapeMode === "none" ? undefined : { escapeMode }),
  ).toEqual(expected);
});

it("preserves empty single-quoted ExecStart arguments", () => {
  expect(parseSystemdExecStart("run '' next ''")).toEqual(["run", "", "next", ""]);
});

it("parses quoted assignments while preserving unquoted apostrophes", () => {
  expect(parseSystemdEnvAssignments("'TOKEN=a b' FOO=bar")).toEqual([
    { key: "TOKEN", value: "a b" },
    { key: "FOO", value: "bar" },
  ]);
  expect(parseSystemdEnvAssignments("FOO=can't TOKEN=token")).toEqual([
    { key: "FOO", value: "can't" },
    { key: "TOKEN", value: "token" },
  ]);
});
