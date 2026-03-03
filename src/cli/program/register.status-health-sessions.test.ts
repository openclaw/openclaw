import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const statusCommand = vi.fn();
const healthCommand = vi.fn();
const sessionsCommand = vi.fn();
const sessionsCleanupCommand = vi.fn();
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

vi.mock("../../commands/sessions-cleanup.js", () => ({
  sessionsCleanupCommand,
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
    sessionsCleanupCommand.mockResolvedValue(undefined);
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

  it("runs sessions command with --agent forwarding", async () => {
    await runCli(["sessions", "--agent", "work"]);

    expect(sessionsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "work",
        allAgents: false,
      }),
      runtime,
    );
  });

  it("runs sessions command with --all-agents forwarding", async () => {
    await runCli(["sessions", "--all-agents"]);

    expect(sessionsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allAgents: true,
      }),
      runtime,
    );
  });

  it("runs sessions cleanup subcommand with forwarded options", async () => {
    await runCli([
      "sessions",
      "cleanup",
      "--store",
      "/tmp/sessions.json",
      "--dry-run",
      "--enforce",
      "--fix-missing",
      "--active-key",
      "agent:main:main",
      "--json",
    ]);

    expect(sessionsCleanupCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        store: "/tmp/sessions.json",
        agent: undefined,
        allAgents: false,
        dryRun: true,
        enforce: true,
        fixMissing: true,
        activeKey: "agent:main:main",
        json: true,
      }),
      runtime,
    );
  });

  it("forwards parent-level all-agents to cleanup subcommand", async () => {
    await runCli(["sessions", "--all-agents", "cleanup", "--dry-run"]);

    expect(sessionsCleanupCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allAgents: true,
      }),
      runtime,
    );
  });
});
