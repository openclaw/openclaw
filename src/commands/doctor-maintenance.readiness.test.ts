import "./doctor-maintenance.settlement.test-support.js";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import { ExitError } from "../runtime.js";
import { doctorCommand } from "./doctor.js";

const runtime = vi.hoisted(() => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("./doctor.js", () => ({ doctorCommand: vi.fn() }));

const { begin, boundary } = await import("./doctor-maintenance.settlement.test-support.js");

it.each([
  { outcome: "starting", phase: "waiting for Gateway listener", elapsedMs: 60_000, code: 0 },
  { outcome: "failed", phase: "waiting for managed service", elapsedMs: 60_000, code: 1 },
] as const)("doctor --fix exits $code for $phase", async ({ outcome, phase, elapsedMs, code }) => {
  boundary.health.mockResolvedValue({
    outcome,
    healthy: false,
    staleGatewayPids: [],
    runtime:
      outcome === "starting"
        ? { status: "running", pid: 4242 }
        : { status: "stopped", state: "failed", lastExitStatus: 1 },
    portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
    waitOutcome: outcome === "starting" ? "still-starting" : "stopped-free",
    elapsedMs,
    startupPhase: phase,
  });
  runtime.error.mockClear();
  runtime.exit.mockImplementation((exitCode) => {
    throw new ExitError(exitCode);
  });
  const maintenance = await begin();
  // Run restoration through the real CLI exit boundary without unrelated repair scans.
  vi.mocked(doctorCommand).mockImplementation(async () => maintenance!.finish({}));
  const program = new Command();
  registerMaintenanceCommands(program);
  await expect(
    program.parseAsync(["doctor", "--fix", "--non-interactive"], { from: "user" }),
  ).rejects.toMatchObject({ code });

  const warning =
    "Warning: Doctor repair complete; Gateway is still starting — check `openclaw gateway status` in a minute.";
  if (outcome === "starting") {
    expect(maintenance!.warnings).toContain(warning);
    expect(maintenance!.failureFacts).toEqual([]);
    expect(boundary.log).toHaveBeenCalledWith(warning);
    expect(runtime.error).not.toHaveBeenCalled();
  } else {
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Doctor gateway-restoration failed"),
    );
    expect(maintenance!.warnings).not.toContain(warning);
  }
  expect(boundary.log).not.toHaveBeenCalledWith(
    "Gateway restarted and verified after Doctor repair.",
  );
  expect(boundary.restart).toHaveBeenCalledOnce();
});
