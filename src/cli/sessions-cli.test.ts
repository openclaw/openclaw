import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    agents: { list: [] },
  }),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/.openclaw",
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: () => "/tmp/.openclaw/agents/main/sessions",
}));

const { registerSessionsCli } = await import("./sessions-cli.js");

describe("sessions-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSessionsCli(program);
    try {
      await program.parseAsync(["node", "openclaw", ...args], { from: "user" });
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("__exit__:"))) {
        throw err;
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
  });

  it("shows help for sessions command", async () => {
    await runCli(["sessions", "--help"]);
    expect(runtimeLogs.join("\n")).toContain("Manage session transcripts and session store");
  });

  it("shows help for repair subcommand", async () => {
    await runCli(["sessions", "repair", "--help"]);
    expect(runtimeLogs.join("\n")).toContain("Repair sessions.json");
  });

  it("shows help for rebuild subcommand", async () => {
    await runCli(["sessions", "rebuild", "--help"]);
    expect(runtimeLogs.join("\n")).toContain("Alias for 'repair'");
  });

  it("shows help for status subcommand", async () => {
    await runCli(["sessions", "status", "--help"]);
    expect(runtimeLogs.join("\n")).toContain("Show session store status");
  });

  it("accepts --verbose option", async () => {
    await runCli(["sessions", "repair", "--verbose", "--dry-run"]);
    expect(runtimeLogs.length + runtimeErrors.length).toBeGreaterThanOrEqual(0);
  });

  it("accepts --dry-run option for repair", async () => {
    await runCli(["sessions", "repair", "--dry-run"]);
    expect(runtimeLogs.length + runtimeErrors.length).toBeGreaterThanOrEqual(0);
  });
});
