// Doctor startup maintenance tests cover channel preview warnings and startup repair flow.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as startup from "../channels/plugins/lifecycle-startup.js";
import {
  collectChannelPreviewWarningHealthFindings,
  maybeRunDoctorStartupChannelMaintenance,
} from "./doctor-startup-channel-maintenance.js";

const mocks = vi.hoisted(() => ({
  resolveDoctorChannelPreviewConfig: vi.fn(async (params: { cfg: unknown }) => ({
    cfg: params.cfg,
    diagnostics: [],
  })),
  collectChannelDoctorPreviewWarnings: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock("../commands/doctor/shared/preview-warnings.js", () => ({
  resolveDoctorChannelPreviewConfig: mocks.resolveDoctorChannelPreviewConfig,
}));

vi.mock("../commands/doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorPreviewWarnings: mocks.collectChannelDoctorPreviewWarnings,
}));

describe("doctor startup channel maintenance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.resolveDoctorChannelPreviewConfig.mockReset().mockImplementation(async (params) => ({
      cfg: params.cfg,
      diagnostics: [],
    }));
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
      collectChannelPreviewWarningHealthFindings({
        cfg,
        allowExec: true,
      }),
    ).resolves.toEqual([
      {
        checkId: "core/doctor/channel-preview-warnings",
        severity: "warning",
        message: "channels.matrix: stale config needs startup maintenance.",
        path: "channels.matrix",
        requirement: "Configured channels should not emit doctor preview warnings.",
        fixHint:
          "Run `openclaw doctor --fix` if the channel warning recommends repair, or update the affected channel config manually.",
      },
    ]);
    expect(mocks.resolveDoctorChannelPreviewConfig).toHaveBeenCalledWith({
      cfg,
      env: process.env,
      allowExec: true,
    });
    expect(mocks.collectChannelDoctorPreviewWarnings).toHaveBeenCalledWith({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
      env: process.env,
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
    const runtimeCalls: string[] = [];
    const runtime = {
      log: (message: string) => runtimeCalls.push(`log:${message}`),
      error: (message: string) => runtimeCalls.push(`error:${message}`),
    };

    const run = vi
      .spyOn(startup, "runChannelPluginStartupMaintenance")
      .mockResolvedValue(undefined);
    await maybeRunDoctorStartupChannelMaintenance({
      cfg,
      runtime,
      shouldRepair: true,
    });

    expect(run).toHaveBeenCalledOnce();
    const call = run.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("Expected startup maintenance call");
    }
    expect(call.cfg).toBe(cfg);
    expect(call.env).toBe(process.env);
    expect(call.trigger).toBe("doctor-fix");
    expect(call.logPrefix).toBe("doctor");
    expect(call.log.info).toBeTypeOf("function");
    expect(call.log.warn).toBeTypeOf("function");
    call.log.info?.("migrated");
    call.log.warn?.("needs attention");
    expect(runtimeCalls).toEqual(["log:migrated", "error:needs attention"]);
  });

  it("skips startup migration outside repair flows", async () => {
    const run = vi
      .spyOn(startup, "runChannelPluginStartupMaintenance")
      .mockResolvedValue(undefined);
    await maybeRunDoctorStartupChannelMaintenance({
      cfg: { channels: { matrix: {} } },
      runtime: { log() {}, error() {} },
      shouldRepair: false,
    });

    expect(run).not.toHaveBeenCalled();
  });
});
