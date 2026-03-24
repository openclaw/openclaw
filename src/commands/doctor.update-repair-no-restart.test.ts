import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditGatewayServiceConfig,
  buildGatewayInstallPlan,
  confirm,
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  serviceReadCommand,
  serviceInstall,
  serviceIsLoaded,
  serviceRestart,
  writeConfigFile,
} from "./doctor.e2e-harness.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;
let healthCommand: typeof import("./health.js").healthCommand;

describe("doctor command update-mode repairs", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ doctorCommand } = await import("./doctor.js"));
    ({ healthCommand } = await import("./health.js"));
  });

  it("skips gateway installs during non-interactive update repairs", async () => {
    mockDoctorConfigSnapshot();

    vi.mocked(healthCommand).mockRejectedValueOnce(new Error("gateway closed"));

    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceInstall.mockClear();
    serviceRestart.mockClear();
    confirm.mockClear();

    await doctorCommand(createDoctorRuntime(), { repair: true, nonInteractive: true });

    expect(serviceInstall).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skips gateway restarts during non-interactive update repairs", async () => {
    mockDoctorConfigSnapshot();

    vi.mocked(healthCommand).mockRejectedValueOnce(new Error("gateway closed"));

    serviceIsLoaded.mockResolvedValueOnce(true);
    serviceRestart.mockClear();
    confirm.mockClear();

    await doctorCommand(createDoctorRuntime(), { repair: true, nonInteractive: true });

    expect(serviceRestart).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skips gateway service-config reinstalls and token persistence during non-interactive update repairs", async () => {
    mockDoctorConfigSnapshot({ config: { gateway: {} }, parsed: { gateway: {} } });

    vi.mocked(healthCommand).mockRejectedValueOnce(new Error("gateway closed"));

    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["node", "cli", "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-token",
      },
    });
    auditGatewayServiceConfig.mockResolvedValueOnce({
      ok: false,
      issues: [
        {
          code: "gateway-token-mismatch",
          message: "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token",
          level: "recommended",
        },
      ],
    });
    buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["node", "cli", "gateway", "--port", "18789"],
      workingDirectory: "/tmp",
      environment: {},
    });
    serviceInstall.mockClear();
    serviceRestart.mockClear();
    writeConfigFile.mockClear();
    confirm.mockClear();

    await doctorCommand(createDoctorRuntime(), { repair: true, nonInteractive: true });

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(serviceInstall).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
