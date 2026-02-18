import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const doctorCommand = vi.fn();
const dashboardCommand = vi.fn();
const resetCommand = vi.fn();
const uninstallCommand = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/doctor.js", () => ({
  doctorCommand,
}));

vi.mock("../../commands/dashboard.js", () => ({
  dashboardCommand,
}));

vi.mock("../../commands/reset.js", () => ({
  resetCommand,
}));

vi.mock("../../commands/uninstall.js", () => ({
  uninstallCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

describe("registerMaintenanceCommands doctor action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits with code 0 after successful doctor run", async () => {
    doctorCommand.mockResolvedValue(undefined);

    const { registerMaintenanceCommands } = await import("./register.maintenance.js");
    const program = new Command();
    registerMaintenanceCommands(program);

    await program.parseAsync(["doctor", "--non-interactive", "--yes"], { from: "user" });

    expect(doctorCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        nonInteractive: true,
        yes: true,
      }),
    );
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when doctor fails", async () => {
    doctorCommand.mockRejectedValue(new Error("doctor failed"));

    const { registerMaintenanceCommands } = await import("./register.maintenance.js");
    const program = new Command();
    registerMaintenanceCommands(program);

    await program.parseAsync(["doctor"], { from: "user" });

    expect(runtime.error).toHaveBeenCalledWith("Error: doctor failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(0);
  });
});
