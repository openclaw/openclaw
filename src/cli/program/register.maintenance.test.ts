import { EventEmitter } from "node:events";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const doctorCommand = vi.fn();
const dashboardCommand = vi.fn();
const resetCommand = vi.fn();
const uninstallCommand = vi.fn();
const spawnMock = vi.fn();

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

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const mockedModuleIds = [
  "../../commands/doctor.js",
  "../../commands/dashboard.js",
  "../../commands/reset.js",
  "../../commands/uninstall.js",
  "../../runtime.js",
];

let registerMaintenanceCommands: typeof import("./register.maintenance.js").registerMaintenanceCommands;

beforeAll(async () => {
  ({ registerMaintenanceCommands } = await import("./register.maintenance.js"));
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

describe("registerMaintenanceCommands doctor action", () => {
  async function runMaintenanceCli(args: string[]) {
    const program = new Command();
    registerMaintenanceCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_DOCTOR_CHILD", "1");
  });

  it("exits with code 0 after successful doctor run", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--non-interactive", "--yes"]);

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

    await runMaintenanceCli(["doctor"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: doctor failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(0);
  });

  it("maps --fix to repair=true", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--fix"]);

    expect(doctorCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        repair: true,
      }),
    );
  });

  it("fails fast when non-interactive doctor exceeds the timeout budget", async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_DOCTOR_TIMEOUT_MS", "10");
    const originalArgv = process.argv;
    process.argv = [process.execPath, "dist/index.js", "doctor", "--non-interactive"];
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.kill = vi.fn();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnMock.mockReturnValue(child);

    try {
      const run = runMaintenanceCli(["doctor", "--non-interactive"]);
      child.stderr.emit(
        "data",
        Buffer.from("[doctor-debug] providers.runtime:loadOpenClawPlugins:start\n"),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await run;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Last observed stage: providers.runtime:loadOpenClawPlugins:start."),
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Likely heavy area: provider plugin discovery or plugin loader initialization.",
        ),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("passes noOpen to dashboard command", async () => {
    dashboardCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["dashboard", "--no-open"]);

    expect(dashboardCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        noOpen: true,
      }),
    );
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

    expect(resetCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        scope: "full",
        yes: true,
        nonInteractive: true,
        dryRun: true,
      }),
    );
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

    expect(uninstallCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        service: true,
        state: true,
        workspace: true,
        app: true,
        all: true,
        yes: true,
        nonInteractive: true,
        dryRun: true,
      }),
    );
  });

  it("exits with code 1 when dashboard fails", async () => {
    dashboardCommand.mockRejectedValue(new Error("dashboard failed"));

    await runMaintenanceCli(["dashboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: dashboard failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
