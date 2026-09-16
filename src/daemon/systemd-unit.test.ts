// Systemd unit tests cover generated systemd unit files.
import { describe, expect, it } from "vitest";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  renderSystemdEnvAssignment,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

// Values that need quoting, including the backslash and quote shapes the
// renderer has to escape for the module's own parsers to read them back.
const ROUND_TRIP_VALUES = [
  "plain",
  "with space",
  'he said "hi"',
  "back\\slash",
  "C:\\\\srv\\\\bin",
  'mix \\ and " here',
  "trailing\\",
];

describe("systemd logical lines", () => {
  it.each([
    {
      name: "standalone comment backslashes",
      input: ["# note \\", "; note \\", "ExecStart=/usr/bin/openclaw gateway run"],
      expected: ["# note \\", "; note \\", "ExecStart=/usr/bin/openclaw gateway run"],
    },
    {
      name: "comments inside a continued quoted value",
      input: ['Environment="SETTING=one\\', " # note \\", " ; note", '  two"'],
      expected: ['Environment="SETTING=one   two"'],
    },
    {
      name: "escaped trailing backslash pairs",
      input: ["Environment=SETTING=one\\\\", "ExecStart=/usr/bin/openclaw gateway run"],
      expected: ["Environment=SETTING=one\\\\", "ExecStart=/usr/bin/openclaw gateway run"],
    },
    {
      name: "blank line ending a continuation",
      input: ["Environment=SETTING=one\\", "", "ExecStart=/usr/bin/openclaw gateway run"],
      expected: ["Environment=SETTING=one ", "ExecStart=/usr/bin/openclaw gateway run"],
    },
    {
      name: "continued value at EOF",
      input: ["Environment=SETTING=one\\", " # note"],
      expected: ["Environment=SETTING=one "],
    },
  ])("preserves $name for LF and CRLF", ({ input, expected }) => {
    for (const separator of ["\n", "\r\n"]) {
      expect(splitSystemdLogicalLines(input.join(separator))).toEqual(expected);
    }
  });
});

describe("systemd unit value round-trips", () => {
  it.each(ROUND_TRIP_VALUES)("round-trips %p through Environment=", (value) => {
    const rendered = renderSystemdEnvAssignment("OPENCLAW_TOKEN", value);
    expect(parseSystemdEnvAssignments(rendered)).toEqual([{ key: "OPENCLAW_TOKEN", value }]);
  });

  it.each(ROUND_TRIP_VALUES)("round-trips %p through ExecStart=", (value) => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", value],
      environment: {},
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(parseSystemdExecStart(execStart?.slice("ExecStart=".length) ?? "")).toEqual([
      "/usr/bin/openclaw",
      "gateway",
      value,
    ]);
  });

  it.each([
    { name: "already-encoded %% specifier", value: "100%%s" },
    { name: "intentional %h expansion", value: "%h/cache" },
  ])("rewrite re-render preserves $name verbatim", ({ value }) => {
    expect(renderSystemdEnvAssignment("OTHER_SETTING", value)).toBe(`"OTHER_SETTING=${value}"`);
  });

  it("keeps scalar paths unquoted while doubling % specifiers", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      workingDirectory: "/srv/state%h",
      environmentFiles: ["/srv/state%h/env"],
      environment: {},
    });
    expect(unit).toContain("WorkingDirectory=/srv/state%%h");
    expect(unit).toContain("EnvironmentFile=-/srv/state%%h/env");
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).not.toContain('EnvironmentFile=-"');
  });

  it("refuses EnvironmentFile entries containing whitespace (systemd ignores quoted paths)", () => {
    expect(() =>
      buildSystemdUnit({
        description: "OpenClaw Gateway",
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        environmentFiles: ["/srv/Open Claw/env"],
        environment: {},
      }),
    ).toThrow(/whitespace/);
  });

  it("refuses scalar paths ending in a backslash", () => {
    expect(() =>
      buildSystemdUnit({
        description: "OpenClaw Gateway",
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/srv/trailing\\",
        environment: {},
      }),
    ).toThrow(/backslash/);
  });
});

describe("buildSystemdUnit", () => {
  it.each(["", "--max-old-space-size=24576"])(
    "preserves explicit NODE_OPTIONS=%j while omitting other empty values",
    (nodeOptions) => {
      const programArguments = ["/usr/bin/node", "--max-old-space-size=16384", "gateway.js"];
      const unit = buildSystemdUnit({
        programArguments,
        environment: { NODE_OPTIONS: nodeOptions, UNUSED: "", MISSING: undefined },
      });
      const lines = unit.split("\n");
      expect(
        lines
          .filter((line) => line.startsWith("Environment="))
          .flatMap((line) => parseSystemdEnvAssignments(line.slice("Environment=".length))),
      ).toEqual([{ key: "NODE_OPTIONS", value: nodeOptions }]);
      const execStart = lines.find((line) => line.startsWith("ExecStart="));
      expect(parseSystemdExecStart(execStart?.slice("ExecStart=".length) ?? "")).toEqual(
        programArguments,
      );
    },
  );

  it("quotes arguments with whitespace", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "--name", "My Bot"],
      environment: {},
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe('ExecStart=/usr/bin/openclaw gateway --name "My Bot"');
  });

  it("doubles % specifiers in Environment and ExecStart so systemd preserves them", () => {
    const programArguments = ["/usr/bin/openclaw", "run", "tail%s%name"];
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments,
      environment: { OPENCLAW_PROXY_URL: "http://proxy/%2fapi" },
    });
    const environmentLine = unit.split("\n").find((line) => line.startsWith("Environment="));
    expect(environmentLine).toBe('Environment="OPENCLAW_PROXY_URL=http://proxy/%%2fapi"');
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toContain("tail%%s%%name");
  });

  it("drains through the main process while retaining final child-process cleanup", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: {},
    });
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain("TimeoutStopSec=330");
    expect(unit).toContain("TimeoutStartSec=30");
    expect(unit).toContain("SuccessExitStatus=0 143");
    expect(unit).toContain("OOMPolicy=continue");
    expect(unit).toContain("StartLimitBurst=10");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("RestartPreventExitStatus=78");
  });

  it("rejects environment values with line breaks", () => {
    expect(() =>
      buildSystemdUnit({
        description: "OpenClaw Gateway",
        programArguments: ["/usr/bin/openclaw", "gateway", "start"],
        environment: {
          INJECT: "ok\nExecStartPre=/bin/touch /tmp/oc15789_rce",
        },
      }),
    ).toThrow(/CR or LF/);
  });

  it("renders EnvironmentFile entries before inline Environment values", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environmentFiles: ["/home/test/.openclaw/.env"],
      environment: {
        OPENCLAW_GATEWAY_PORT: "18789",
      },
    });
    expect(unit).toContain("EnvironmentFile=-/home/test/.openclaw/.env");
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
    expect(unit.indexOf("EnvironmentFile=-/home/test/.openclaw/.env")).toBeLessThan(
      unit.indexOf("Environment=OPENCLAW_GATEWAY_PORT=18789"),
    );
  });
});
