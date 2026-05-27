import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, writeConfigFile } from "./doctor.e2e-harness.js";

const DOCTOR_MIGRATION_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 45_000;
const { doctorCommand } = await import("./doctor.js");

describe("doctor command", () => {
  it(
    "migrates Slack/Discord dm.policy keys to dmPolicy aliases",
    { timeout: DOCTOR_MIGRATION_TIMEOUT_MS },
    async () => {
      readConfigFileSnapshot.mockResolvedValue({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {
          channels: {
            slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
            discord: {
              dm: { enabled: true, policy: "allowlist", allowFrom: ["123"] },
            },
          },
        },
        valid: true,
        config: {
          channels: {
            slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
            discord: { dm: { enabled: true, policy: "allowlist", allowFrom: ["123"] } },
          },
        },
        issues: [],
        legacyIssues: [],
      });

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await doctorCommand(runtime, { nonInteractive: true, repair: true });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
      const channels = (written.channels ?? {}) as Record<string, unknown>;
      const slack = (channels.slack ?? {}) as Record<string, unknown>;
      const discord = (channels.discord ?? {}) as Record<string, unknown>;

      expect(slack.dmPolicy).toBe("open");
      expect(slack.allowFrom).toEqual(["*"]);
      expect(slack.dm).toEqual({ enabled: true });

      expect(discord.dmPolicy).toBe("allowlist");
      expect(discord.allowFrom).toEqual(["123"]);
      expect(discord.dm).toEqual({ enabled: true });
    },
  );
});
