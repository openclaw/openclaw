import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, writeConfigFile } from "./doctor.e2e-harness.js";

const DOCTOR_MIGRATION_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 45_000;
const { doctorCommand } = await import("./doctor.js");

describe("doctor command", () => {
  it(
    "does not rewrite supported Slack/Discord dm.policy aliases",
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
      writeConfigFile.mockClear();

      await doctorCommand(runtime, { nonInteractive: true, repair: true });

      expect(writeConfigFile).not.toHaveBeenCalled();
    },
  );
});
