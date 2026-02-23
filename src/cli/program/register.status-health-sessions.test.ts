import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const statusCommand = vi.fn();
const healthCommand = vi.fn();
const sessionsCommand = vi.fn();
const setVerbose = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/status.js", () => ({
  statusCommand,
}));

vi.mock("../../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../../commands/sessions.js", () => ({
  sessionsCommand,
}));

vi.mock("../../globals.js", () => ({
  setVerbose,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerStatusHealthSessionsCommands: typeof import("./register.status-health-sessions.js").registerStatusHealthSessionsCommands;

beforeAll(async () => {
  ({ registerStatusHealthSessionsCommands } = await import("./register.status-health-sessions.js"));
});

describe("registerStatusHealthSessionsCommands", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerStatusHealthSessionsCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    statusCommand.mockResolvedValue(undefined);
    healthCommand.mockResolvedValue(undefined);
    sessionsCommand.mockResolvedValue(undefined);
  });

  it("runs status command with timeout and debug-derived verbose", async () => {
    await runCli([
      "status",
      "--json",
      "--all",
      "--deep",
      "--usage",
      "--debug",
      "--timeout",
      "5000",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expect(statusCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        all: true,
        deep: true,
        usage: true,
        timeoutMs: 5000,
        verbose: true,
      }),
      runtime,
    );
  });

  it("rejects invalid status timeout without calling status command", async () => {
    await runCli(["status", "--timeout", "nope"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(statusCommand).not.toHaveBeenCalled();
  });

  it("runs health command with parsed timeout", async () => {
    await runCli(["health", "--json", "--timeout", "2500", "--verbose"]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expect(healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        timeoutMs: 2500,
        verbose: true,
      }),
      runtime,
    );
  });

  it("rejects invalid health timeout without calling health command", async () => {
    await runCli(["health", "--timeout", "0"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(healthCommand).not.toHaveBeenCalled();
  });

  it("runs sessions command with forwarded options", async () => {
    await runCli([
      "sessions",
      "--json",
      "--verbose",
      "--store",
      "/tmp/sessions.json",
      "--active",
      "120",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expect(sessionsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        store: "/tmp/sessions.json",
        active: "120",
      }),
      runtime,
    );
  });
});
