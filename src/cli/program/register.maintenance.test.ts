// Register maintenance tests cover maintenance command registration in the CLI program.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "./register.maintenance.js";

const mocks = vi.hoisted(() => ({
  doctorCommand: vi.fn(),
  dashboardCommand: vi.fn(),
  resetCommand: vi.fn(),
  uninstallCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
  runDoctorLintCli: vi.fn(),
  runDoctorSelectedRepairCli: vi.fn(),
}));

const {
  doctorCommand,
  dashboardCommand,
  resetCommand,
  uninstallCommand,
  runtime,
  runDoctorLintCli,
  runDoctorSelectedRepairCli,
} = mocks;

vi.mock("../../commands/doctor.js", () => ({
  doctorCommand: mocks.doctorCommand,
}));

vi.mock("../../commands/dashboard.js", () => ({
  dashboardCommand: mocks.dashboardCommand,
}));

vi.mock("../../commands/reset.js", () => ({
  resetCommand: mocks.resetCommand,
}));

vi.mock("../../commands/uninstall.js", () => ({
  uninstallCommand: mocks.uninstallCommand,
}));

vi.mock("../../commands/doctor-lint.js", () => ({
  runDoctorLintCli: mocks.runDoctorLintCli,
  runDoctorSelectedRepairCli: mocks.runDoctorSelectedRepairCli,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

function commandCall(mock: ReturnType<typeof vi.fn>): [typeof runtime, Record<string, unknown>] {
  const call = mock.mock.calls[0] as [typeof runtime, Record<string, unknown>] | undefined;
  if (!call) {
    throw new Error("expected command call");
  }
  return call;
}

describe("registerMaintenanceCommands doctor action", () => {
  async function runMaintenanceCli(args: string[]) {
    const program = new Command();
    registerMaintenanceCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits with code 0 after successful doctor run", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--non-interactive", "--yes", "--allow-exec"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(doctorCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.nonInteractive).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.allowExec).toBe(true);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when doctor fails", async () => {
    doctorCommand.mockRejectedValue(new Error("doctor failed"));

    await runMaintenanceCli(["doctor"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: doctor failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(0);
  });

  it("maps --fix to repair=true", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--fix"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(doctorCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.repair).toBe(true);
  });

  it("runs doctor lint mode without invoking repair doctor", async () => {
    runDoctorLintCli.mockResolvedValue(1);

    await runMaintenanceCli([
      "doctor",
      "--lint",
      "--json",
      "--severity-min",
      "error",
      "--skip",
      "a",
      "--only",
      "b",
      "--allow-exec",
    ]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).toHaveBeenCalledWith(runtime, {
      json: true,
      explain: false,
      severityMin: "error",
      skipIds: ["a"],
      onlyIds: ["b"],
      allowExec: true,
      nonInteractive: false,
      confirmRepairCheck: undefined,
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("runs focused doctor repair for --fix --only", async () => {
    runDoctorSelectedRepairCli.mockResolvedValue(0);

    await runMaintenanceCli(["doctor", "--fix", "--only", "core/doctor/skills-readiness"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorSelectedRepairCli).toHaveBeenCalledWith(runtime, {
      onlyIds: ["core/doctor/skills-readiness"],
      allowExec: false,
    });
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("runs doctor explain mode through the structured health path", async () => {
    runDoctorLintCli.mockResolvedValue(1);

    await runMaintenanceCli([
      "doctor",
      "--explain",
      "--severity-min",
      "warning",
      "--only",
      "core/doctor/gateway-config",
      "--non-interactive",
    ]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).toHaveBeenCalledWith(runtime, {
      json: false,
      explain: true,
      severityMin: "warning",
      skipIds: [],
      onlyIds: ["core/doctor/gateway-config"],
      allowExec: false,
      nonInteractive: true,
      confirmRepairCheck: expect.any(Function),
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects JSON explain output", async () => {
    await runMaintenanceCli(["doctor", "--explain", "--json"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("doctor --explain cannot be combined with --json.");
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("rejects combined lint and explain modes", async () => {
    await runMaintenanceCli(["doctor", "--lint", "--explain"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("doctor --lint cannot be combined with --explain.");
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("exits with code 2 when doctor lint mode fails before findings are emitted", async () => {
    runDoctorLintCli.mockRejectedValue(new Error("lint failed"));

    await runMaintenanceCli(["doctor", "--lint"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: lint failed");
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("rejects lint-only selectors outside lint mode", async () => {
    await runMaintenanceCli(["doctor", "--only", "core/example"]);

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDoctorLintCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor structured health options require --lint, --explain, or --fix --only.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("rejects unsupported focused repair filters", async () => {
    await runMaintenanceCli([
      "doctor",
      "--fix",
      "--only",
      "core/doctor/skills-readiness",
      "--skip",
      "core/doctor/gateway-config",
    ]);

    expect(runDoctorSelectedRepairCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor --fix --only supports --allow-exec only; use --lint or --explain for filtering output.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it.each([
    ["--post-upgrade"],
    ["--deep"],
    ["--force"],
    ["--generate-gateway-token"],
    ["--yes"],
    ["--non-interactive"],
  ])("rejects focused repair with unsupported doctor option %s", async (flag) => {
    await runMaintenanceCli(["doctor", "--fix", "--only", "core/doctor/skills-readiness", flag]);

    expect(runDoctorSelectedRepairCli).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "doctor --fix --only supports --allow-exec only; use --lint or --explain for filtering output.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });

  it("passes noOpen to dashboard command", async () => {
    dashboardCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["dashboard", "--no-open"]);

    expect(dashboardCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(dashboardCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.noOpen).toBe(true);
  });

  it("passes reset options to reset command", async () => {
    resetCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "reset",
      "--scope",
      "full",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(resetCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(resetCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.scope).toBe("full");
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it("passes uninstall options to uninstall command", async () => {
    uninstallCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "uninstall",
      "--service",
      "--state",
      "--workspace",
      "--app",
      "--all",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(uninstallCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = commandCall(uninstallCommand);
    expect(runtimeArg).toBe(runtime);
    expect(options.service).toBe(true);
    expect(options.state).toBe(true);
    expect(options.workspace).toBe(true);
    expect(options.app).toBe(true);
    expect(options.all).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it("exits with code 1 when dashboard fails", async () => {
    dashboardCommand.mockRejectedValue(new Error("dashboard failed"));

    await runMaintenanceCli(["dashboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: dashboard failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
