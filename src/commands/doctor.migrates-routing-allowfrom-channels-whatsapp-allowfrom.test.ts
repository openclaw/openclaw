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
import "./doctor.fast-path-mocks.js";

const DOCTOR_MIGRATION_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 45_000;
const { doctorCommand } = await import("./doctor.js");

describe("doctor command", () => {
  it("does not add a new gateway auth token while fixing legacy issues on invalid config", async () => {
    mockDoctorConfigSnapshot({
      config: {
        routing: { allowFrom: ["+15555550123"] },
        gateway: { remote: { token: "legacy-remote-token" } },
      },
      parsed: {
        routing: { allowFrom: ["+15555550123"] },
        gateway: { remote: { token: "legacy-remote-token" } },
      },
      valid: false,
      issues: [{ path: "routing.allowFrom", message: "legacy" }],
      legacyIssues: [{ path: "routing.allowFrom", message: "legacy" }],
    });

    const runtime = createDoctorRuntime();

    migrateLegacyConfig.mockReturnValue({
      config: {
        channels: { whatsapp: { allowFrom: ["+15555550123"] } },
        gateway: { remote: { token: "legacy-remote-token" } },
      },
      changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
    });

    await doctorCommand(runtime, { repair: true });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
    const gateway = (written.gateway as Record<string, unknown>) ?? {};
    const auth = gateway.auth as Record<string, unknown> | undefined;
    const remote = gateway.remote as Record<string, unknown>;
    const channels = (written.channels as Record<string, unknown>) ?? {};

    expect(channels.whatsapp).toEqual({
      allowFrom: ["+15555550123"],
    });
    expect(written.routing).toBeUndefined();
    expect(remote.token).toBe("legacy-remote-token");
    expect(auth).toBeUndefined();
  });

  it(
    "skips legacy gateway services migration",
    { timeout: DOCTOR_MIGRATION_TIMEOUT_MS },
    async () => {
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

      await doctorCommand(createDoctorRuntime());

      expect(uninstallLegacyGatewayServices).not.toHaveBeenCalled();
      expect(serviceInstall).not.toHaveBeenCalled();
    },
  );

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

    await doctorCommand(createDoctorRuntime());

    expect(runGatewayUpdate).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(
      note.mock.calls.some(([, title]) => typeof title === "string" && title === "Update result"),
    ).toBe(true);
  });
});
