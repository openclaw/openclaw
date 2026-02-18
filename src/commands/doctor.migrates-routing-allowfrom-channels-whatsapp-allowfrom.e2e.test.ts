import { describe, expect, it } from "vitest";
import {
  createDoctorRuntime,
  findLegacyGatewayServices,
  migrateLegacyConfig,
  mockDoctorConfigSnapshot,
  note,
  readConfigFileSnapshot,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runGatewayUpdate,
  serviceInstall,
  serviceIsLoaded,
  uninstallLegacyGatewayServices,
  writeConfigFile,
} from "./doctor.e2e-harness.js";

describe("doctor command", () => {
  it("migrates routing.allowFrom to channels.whatsapp.allowFrom", { timeout: 60_000 }, async () => {
    mockDoctorConfigSnapshot({
      parsed: { routing: { allowFrom: ["+15555550123"] } },
      valid: false,
      issues: [{ path: "routing.allowFrom", message: "legacy" }],
      legacyIssues: [{ path: "routing.allowFrom", message: "legacy" }],
    });

    const { doctorCommand } = await import("./doctor.js");
    const runtime = createDoctorRuntime();

    migrateLegacyConfig.mockReturnValue({
      config: { channels: { whatsapp: { allowFrom: ["+15555550123"] } } },
      changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
    });

    await doctorCommand(runtime, { nonInteractive: true, repair: true });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((written.channels as Record<string, unknown>)?.whatsapp).toEqual({
      allowFrom: ["+15555550123"],
    });
    expect(written.routing).toBeUndefined();
  });

  it("skips legacy gateway services migration", { timeout: 60_000 }, async () => {
    mockDoctorConfigSnapshot();

    findLegacyGatewayServices.mockResolvedValueOnce([
      {
        platform: "darwin",
        label: "com.steipete.openclaw.gateway",
        detail: "loaded",
      },
    ]);
    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceInstall.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand(createDoctorRuntime());

    expect(uninstallLegacyGatewayServices).not.toHaveBeenCalled();
    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("offers to update first for git checkouts", async () => {
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;

    const root = "/tmp/openclaw";
    resolveOpenClawPackageRoot.mockResolvedValueOnce(root);
    runCommandWithTimeout.mockResolvedValueOnce({
      stdout: `${root}\n`,
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });
    runGatewayUpdate.mockResolvedValueOnce({
      status: "ok",
      mode: "git",
      root,
      steps: [],
      durationMs: 1,
    });

    mockDoctorConfigSnapshot();

    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand(createDoctorRuntime());

    expect(runGatewayUpdate).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(
      note.mock.calls.some(([, title]) => typeof title === "string" && title === "Update result"),
    ).toBe(true);
  });
});
