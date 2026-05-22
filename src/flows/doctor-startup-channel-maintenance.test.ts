import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { maybeRunDoctorStartupChannelMaintenance } from "./doctor-startup-channel-maintenance.js";

const startupMaintenanceMocks = vi.hoisted(() => ({
  runChannelPluginStartupMaintenance: vi.fn(),
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: startupMaintenanceMocks.runChannelPluginStartupMaintenance,
}));

describe("doctor startup channel maintenance", () => {
  beforeEach(() => {
    startupMaintenanceMocks.runChannelPluginStartupMaintenance.mockReset();
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

  it("runs startup migration through the structured repair check", async () => {
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/startup-channel-maintenance",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        },
      },
    };
    const env = { OPENCLAW_TEST: "1" };
    const findings = await check?.detect({
      mode: "fix",
      runtime,
      cfg,
      env,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/startup-channel-maintenance",
      }),
    );
    await expect(
      check?.repair?.(
        {
          mode: "fix",
          runtime,
          cfg,
          env,
        },
        findings ?? [],
      ),
    ).resolves.toEqual({ changes: [] });
    await expect(
      check?.detect(
        {
          mode: "fix",
          runtime,
          cfg,
          env,
        },
        { findings },
      ),
    ).resolves.toEqual([]);
    expect(startupMaintenanceMocks.runChannelPluginStartupMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        env,
        trigger: "doctor-fix",
        logPrefix: "doctor",
      }),
    );
  });
});
