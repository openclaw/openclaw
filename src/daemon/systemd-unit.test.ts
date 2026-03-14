import { describe, expect, it } from "vitest";
import { buildSystemdUnit, parseSystemdEnvAssignment } from "./systemd-unit.js";

describe("buildSystemdUnit", () => {
  it("quotes arguments with whitespace", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "--name", "My Bot"],
      environment: {},
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe('ExecStart=/usr/bin/openclaw gateway --name "My Bot"');
  });

  it("renders control-group kill mode for child-process cleanup", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: {},
    });
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("TimeoutStopSec=30");
    expect(unit).toContain("TimeoutStartSec=30");
    expect(unit).toContain("SuccessExitStatus=0 143");
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
});

describe("parseSystemdEnvAssignment", () => {
  it("unquotes simple assignment", () => {
    expect(parseSystemdEnvAssignment('"FOO=bar"')).toEqual({ key: "FOO", value: "bar" });
  });

  it("handles backslash-escaped quotes in values", () => {
    expect(parseSystemdEnvAssignment('"FOO=bar\\"baz"')).toEqual({ key: "FOO", value: 'bar"baz' });
  });

  it("handles backslash-escaped backslashes in values", () => {
    expect(parseSystemdEnvAssignment('"FOO=bar\\\\baz"')).toEqual({
      key: "FOO",
      value: "bar\\baz",
    });
  });

  it("returns null for empty input", () => {
    expect(parseSystemdEnvAssignment("")).toBeNull();
  });
});
