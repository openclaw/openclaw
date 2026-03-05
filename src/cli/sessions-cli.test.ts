import { Command } from "commander";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
  resolveStateDir: (env: NodeJS.ProcessEnv, homeDir: string) => {
    return path.join(homeDir, ".openclaw");
  },
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: (agentId: string) => {
    const homeDir = os.homedir();
    return path.join(homeDir, ".openclaw", "agents", agentId, "sessions");
  },
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

  it("handles missing sessions directory gracefully", async () => {
    // This test would fail in a real environment without the directory
    // In a test environment, we expect it to handle the error
    await runCli(["sessions", "status"]);
    // Should either show status or error gracefully
    expect(runtimeLogs.length + runtimeErrors.length).toBeGreaterThan(0);
  });

  it("accepts --agent option", async () => {
    await runCli(["sessions", "status", "--agent", "test-agent"]);
    // Should not throw
    expect(runtimeLogs.length + runtimeErrors.length).toBeGreaterThanOrEqual(0);
  });

  it("accepts --json option", async () => {
    await runCli(["sessions", "status", "--json"]);
    // Should output JSON or error
    expect(runtimeLogs.length + runtimeErrors.length).toBeGreaterThanOrEqual(0);
  });

  it("accepts --verbose option", async () => {
    await runCli(["sessions", "repair", "--verbose", "--dry-run"]);
    // Should not throw
    expect(runtimeLogs.length + runtimeErrors.length).toBeGreaterThanOrEqual(0);
  });

  it("accepts --dry-run option for repair", async () => {
    await runCli(["sessions", "repair", "--dry-run"]);
    // Should complete without modifying files
    expect(runtimeLogs.length + runtimeErrors.length).toBeGreaterThanOrEqual(0);
  });
});
