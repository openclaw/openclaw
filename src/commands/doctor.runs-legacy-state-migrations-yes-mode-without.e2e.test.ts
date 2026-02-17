import { describe, expect, it, vi } from "vitest";
import {
  arrangeLegacyStateMigrationTest,
  confirm,
  ensureAuthProfileStore,
  readConfigFileSnapshot,
  serviceIsLoaded,
  serviceRestart,
  writeConfigFile,
} from "./doctor.e2e-harness.js";

describe("doctor command", () => {
  it("runs legacy state migrations in yes mode without prompting", async () => {
    const { doctorCommand, runtime, runLegacyStateMigrations } =
      await arrangeLegacyStateMigrationTest();

    await doctorCommand(runtime, { yes: true });

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  }, 30_000);

  it("skips gateway restarts in non-interactive mode", async () => {
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

    const { healthCommand } = await import("./health.js");
    healthCommand.mockRejectedValueOnce(new Error("gateway closed"));

    serviceIsLoaded.mockResolvedValueOnce(true);
    serviceRestart.mockClear();
    confirm.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime, { nonInteractive: true });

    expect(serviceRestart).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("migrates anthropic oauth config profile id when only email profile exists", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
        },
      },
      issues: [],
      legacyIssues: [],
    });

    ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "anthropic:me@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          email: "me@example.com",
        },
      },
    });

    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }, { yes: true });

    const written = writeConfigFile.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const profiles = (written.auth as { profiles: Record<string, unknown> }).profiles;
    expect(profiles["anthropic:me@example.com"]).toBeTruthy();
    expect(profiles["anthropic:default"]).toBeUndefined();
  }, 30_000);
});
