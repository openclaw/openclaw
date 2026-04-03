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

  it("includes crash-loop circuit-breaker directives", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: {},
    });
    // StartLimit* must be in [Unit], not [Service] — systemd ignores them in [Service]
    const lines = unit.split("\n");
    const unitSectionStart = lines.findIndex((l) => l === "[Unit]");
    const serviceSectionStart = lines.findIndex((l) => l === "[Service]");
    const unitLines = lines.slice(unitSectionStart, serviceSectionStart).join("\n");
    const serviceLines = lines.slice(serviceSectionStart).join("\n");
    expect(unitLines).toContain("StartLimitBurst=5");
    expect(unitLines).toContain("StartLimitIntervalSec=60");
    expect(serviceLines).not.toContain("StartLimitBurst");
    expect(serviceLines).not.toContain("StartLimitIntervalSec");
    // RestartPreventExitStatus belongs in [Service]
    expect(serviceLines).toContain("RestartPreventExitStatus=78");
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
