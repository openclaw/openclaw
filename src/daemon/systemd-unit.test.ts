import { describe, expect, it } from "vitest";
import { buildSystemdUnit } from "./systemd-unit.js";

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

  it("renders EnvironmentFile entries before inline environment values", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environmentFiles: ["%h/.openclaw/.env"],
      environment: {
        OPENCLAW_GATEWAY_PORT: "19001",
      },
    });
    expect(unit).toContain("EnvironmentFile=%h/.openclaw/.env");
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=19001");
    expect(unit.indexOf("EnvironmentFile=%h/.openclaw/.env")).toBeLessThan(
      unit.indexOf("Environment=OPENCLAW_GATEWAY_PORT=19001"),
    );
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
