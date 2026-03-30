import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const statusCommand = vi.fn();
const healthCommand = vi.fn();
const sessionsCommand = vi.fn();
const sessionsRemoveCommand = vi.fn();
const sessionsClearCommand = vi.fn();
const sessionsCleanupCommand = vi.fn();
const tasksListCommand = vi.fn();
const tasksAuditCommand = vi.fn();
const tasksMaintenanceCommand = vi.fn();
const tasksShowCommand = vi.fn();
const tasksNotifyCommand = vi.fn();
const tasksCancelCommand = vi.fn();
const setVerbose = vi.fn();

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../commands/status.js", () => ({
  statusCommand,
}));

vi.mock("../../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../../commands/sessions.js", () => ({
  sessionsCommand,
}));

vi.mock("../../commands/sessions-delete.js", () => ({
  sessionsRemoveCommand,
  sessionsClearCommand,
}));

vi.mock("../../commands/sessions-cleanup.js", () => ({
  sessionsCleanupCommand,
}));

vi.mock("../../commands/tasks.js", () => ({
  tasksListCommand,
  tasksAuditCommand,
  tasksMaintenanceCommand,
  tasksShowCommand,
  tasksNotifyCommand,
  tasksCancelCommand,
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
    resetRuntimeCapture();
    runtime.exit.mockImplementation(() => {});
    statusCommand.mockResolvedValue(undefined);
    healthCommand.mockResolvedValue(undefined);
    sessionsCommand.mockResolvedValue(undefined);
    sessionsRemoveCommand.mockResolvedValue(undefined);
    sessionsClearCommand.mockResolvedValue(undefined);
    sessionsCleanupCommand.mockResolvedValue(undefined);
    tasksListCommand.mockResolvedValue(undefined);
    tasksAuditCommand.mockResolvedValue(undefined);
    tasksMaintenanceCommand.mockResolvedValue(undefined);
    tasksShowCommand.mockResolvedValue(undefined);
    tasksNotifyCommand.mockResolvedValue(undefined);
    tasksCancelCommand.mockResolvedValue(undefined);
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

  it("runs sessions rm subcommand with forwarded options", async () => {
    await runCli([
      "sessions",
      "rm",
      "agent:main:main",
      "--store",
      "/tmp/sessions.json",
      "--dry-run",
      "--json",
    ]);

    expect(sessionsRemoveCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "agent:main:main",
        store: "/tmp/sessions.json",
        dryRun: true,
        json: true,
      }),
      runtime,
    );
  });

  it("forwards parent-level all-agents to sessions rm", async () => {
    await runCli(["sessions", "--all-agents", "rm", "agent:main:main"]);

    expect(sessionsRemoveCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "agent:main:main",
        allAgents: true,
      }),
      runtime,
    );
  });

  it("runs sessions clear subcommand with forwarded options", async () => {
    await runCli(["sessions", "clear", "--older-than", "60", "--dry-run", "--json"]);

    expect(sessionsClearCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        olderThan: "60",
        dryRun: true,
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

  it("runs tasks list from the parent command", async () => {
    await runCli(["tasks", "--json", "--runtime", "acp", "--status", "running"]);

    expect(tasksListCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        runtime: "acp",
        status: "running",
      }),
      runtime,
    );
  });

  it("runs tasks show subcommand with lookup forwarding", async () => {
    await runCli(["tasks", "show", "run-123", "--json"]);

    expect(tasksShowCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "run-123",
        json: true,
      }),
      runtime,
    );
  });

  it("runs tasks maintenance subcommand with apply forwarding", async () => {
    await runCli(["tasks", "--json", "maintenance", "--apply"]);

    expect(tasksMaintenanceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        apply: true,
      }),
      runtime,
    );
  });

  it("runs tasks audit subcommand with filters", async () => {
    await runCli([
      "tasks",
      "--json",
      "audit",
      "--severity",
      "error",
      "--code",
      "stale_running",
      "--limit",
      "5",
    ]);

    expect(tasksAuditCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        severity: "error",
        code: "stale_running",
        limit: 5,
      }),
      runtime,
    );
  });

  it("runs tasks notify subcommand with lookup and policy forwarding", async () => {
    await runCli(["tasks", "notify", "run-123", "state_changes"]);

    expect(tasksNotifyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "run-123",
        notify: "state_changes",
      }),
      runtime,
    );
  });

  it("runs tasks cancel subcommand with lookup forwarding", async () => {
    await runCli(["tasks", "cancel", "run-123"]);

    expect(tasksCancelCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "run-123",
      }),
      runtime,
    );
  });
});
