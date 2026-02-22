import { beforeAll, describe, expect, it } from "vitest";
import {
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  writeConfigFile,
} from "./doctor.e2e-harness.js";

const DOCTOR_MIGRATION_TIMEOUT_MS = 20_000;

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
  });

  it(
    "migrates Slack/Discord dm.policy keys to dmPolicy aliases",
    { timeout: DOCTOR_MIGRATION_TIMEOUT_MS },
    async () => {
      mockDoctorConfigSnapshot({
        parsed: {
          channels: {
            slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
            discord: { dm: { enabled: true, policy: "allowlist", allowFrom: ["123"] } },
          },
        },
        config: {
          channels: {
            slack: { dm: { enabled: true, policy: "open", allowFrom: ["*"] } },
            discord: { dm: { enabled: true, policy: "allowlist", allowFrom: ["123"] } },
          },
        },
      });

      await doctorCommand(createDoctorRuntime(), { nonInteractive: true, repair: true });

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
