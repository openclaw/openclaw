// Doctor startup maintenance tests cover channel startup maintenance checks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectStartupChannelMaintenanceHealthFindings,
  maybeRunDoctorStartupChannelMaintenance,
} from "./doctor-startup-channel-maintenance.js";

const mocks = vi.hoisted(() => ({
  collectChannelDoctorPreviewWarnings: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock("../commands/doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorPreviewWarnings: mocks.collectChannelDoctorPreviewWarnings,
}));

describe("doctor startup channel maintenance", () => {
  beforeEach(() => {
    mocks.collectChannelDoctorPreviewWarnings.mockReset().mockResolvedValue([]);
  });

  it("maps channel doctor preview warnings to structured findings", async () => {
    const cfg = {
      channels: {
        matrix: {
          enabled: true,
        },
      },
    };
    mocks.collectChannelDoctorPreviewWarnings.mockResolvedValue([
      "- channels.matrix: stale config needs startup maintenance.",
    ]);

    await expect(
      collectStartupChannelMaintenanceHealthFindings({
        cfg,
        doctorFixCommand: "openclaw doctor --fix --dry-run",
        env: { OPENCLAW_TEST: "1" },
      }),
    ).resolves.toEqual([
      {
        checkId: "core/doctor/startup-channel-maintenance",
        severity: "warning",
        message: "channels.matrix: stale config needs startup maintenance.",
        path: "channels.matrix",
        requirement: "Configured channels should not require startup maintenance before use.",
        fixHint:
          "Run `openclaw doctor --fix --dry-run` to apply safe channel maintenance repairs, or update the affected channel config manually.",
      },
    ]);
    expect(mocks.collectChannelDoctorPreviewWarnings).toHaveBeenCalledWith({
      cfg,
      doctorFixCommand: "openclaw doctor --fix --dry-run",
      env: { OPENCLAW_TEST: "1" },
    });
  });

  it("runs Matrix startup migration during repair flows", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        },
      },
    };
    const calls: unknown[] = [];
    const runtimeCalls: string[] = [];
    const runtime = {
      log: (message: string) => runtimeCalls.push(`log:${message}`),
      error: (message: string) => runtimeCalls.push(`error:${message}`),
    };

    await maybeRunDoctorStartupChannelMaintenance({
      cfg,
      env: { OPENCLAW_TEST: "1" },
      runChannelPluginStartupMaintenance: async (input) => {
        calls.push(input);
      },
      runtime,
      shouldRepair: true,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls as Array<{
      cfg: typeof cfg;
      env: { OPENCLAW_TEST: string };
      log: { info: (message: string) => void; warn: (message: string) => void };
      trigger: string;
      logPrefix: string;
    }>;
    if (!call) {
      throw new Error("Expected startup maintenance call");
    }
    expect(call.cfg).toBe(cfg);
    expect(call.env).toEqual({ OPENCLAW_TEST: "1" });
    expect(call.trigger).toBe("doctor-fix");
    expect(call.logPrefix).toBe("doctor");
    expect(call.log.info).toBeTypeOf("function");
    expect(call.log.warn).toBeTypeOf("function");
    call.log.info("migrated");
    call.log.warn("needs attention");
    expect(runtimeCalls).toEqual(["log:migrated", "error:needs attention"]);
  });

  it("skips startup migration outside repair flows", async () => {
    const calls: unknown[] = [];

    await maybeRunDoctorStartupChannelMaintenance({
      cfg: { channels: { matrix: {} } },
      runChannelPluginStartupMaintenance: async (input) => {
        calls.push(input);
      },
      runtime: { log() {}, error() {} },
      shouldRepair: false,
    });

    expect(calls).toStrictEqual([]);
  });
});
