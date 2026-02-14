import { describe, expect, it, vi } from "vitest";
import { confirm, readConfigFileSnapshot } from "./doctor.e2e-harness.js";

describe("doctor command", () => {
  it("runs legacy state migrations in non-interactive mode without prompting", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {},
      issues: [],
      legacyIssues: [],
    });

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const { detectLegacyStateMigrations, runLegacyStateMigrations } =
      await import("./doctor-state-migrations.js");
    detectLegacyStateMigrations.mockResolvedValueOnce({
      targetAgentId: "main",
      targetMainKey: "main",
      stateDir: "/tmp/state",
      oauthDir: "/tmp/oauth",
      sessions: {
        legacyDir: "/tmp/state/sessions",
        legacyStorePath: "/tmp/state/sessions/sessions.json",
        targetDir: "/tmp/state/agents/main/sessions",
        targetStorePath: "/tmp/state/agents/main/sessions/sessions.json",
        hasLegacy: true,
      },
      agentDir: {
        legacyDir: "/tmp/state/agent",
        targetDir: "/tmp/state/agents/main/agent",
        hasLegacy: false,
      },
      whatsappAuth: {
        legacyDir: "/tmp/oauth",
        targetDir: "/tmp/oauth/whatsapp/default",
        hasLegacy: false,
      },
      preview: ["- Legacy sessions detected"],
    });
    runLegacyStateMigrations.mockResolvedValueOnce({
      changes: ["migrated"],
      warnings: [],
    });

    confirm.mockClear();

    await doctorCommand(runtime, { nonInteractive: true });

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  }, 30_000);
});
