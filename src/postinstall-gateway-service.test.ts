import { beforeEach, describe, expect, it, vi } from "vitest";

const readdirMock = vi.hoisted(() => vi.fn());
const readBestEffortConfigMock = vi.hoisted(() => vi.fn());
const maybeRepairGatewayServiceConfigMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: readdirMock,
  },
  readdir: readdirMock,
}));

vi.mock("./config/config.js", () => ({
  readBestEffortConfig: readBestEffortConfigMock,
}));

vi.mock("./commands/doctor-gateway-services.js", () => ({
  maybeRepairGatewayServiceConfig: maybeRepairGatewayServiceConfigMock,
}));

const { runPostinstallGatewayServiceRepair, shouldRunPostinstallGatewayServiceRepair } =
  await import("./postinstall-gateway-service.js");

describe("postinstall gateway service repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdirMock.mockResolvedValue([]);
    readBestEffortConfigMock.mockResolvedValue({ gateway: {} });
    maybeRepairGatewayServiceConfigMock.mockResolvedValue(undefined);
  });

  it("skips when the install is not global npm", async () => {
    const result = await runPostinstallGatewayServiceRepair({
      platform: "darwin",
      env: {
        HOME: "/Users/test",
        npm_config_global: "false",
      },
    });

    expect(result).toBe(false);
    expect(maybeRepairGatewayServiceConfigMock).not.toHaveBeenCalled();
  });

  it("repairs the default LaunchAgent after global macOS installs", async () => {
    readdirMock.mockResolvedValue(["ai.openclaw.gateway.plist"]);

    const result = await runPostinstallGatewayServiceRepair({
      platform: "darwin",
      env: {
        HOME: "/Users/test",
        npm_config_global: "true",
      },
    });

    expect(result).toBe(true);
    expect(maybeRepairGatewayServiceConfigMock).toHaveBeenCalledWith(
      { gateway: {} },
      "local",
      expect.objectContaining({
        log: expect.any(Function),
        error: expect.any(Function),
        exit: expect.any(Function),
      }),
      expect.objectContaining({
        shouldRepair: true,
        shouldForce: false,
      }),
    );
  });

  it("skips when users explicitly disable postinstall service repair", async () => {
    const shouldRun = shouldRunPostinstallGatewayServiceRepair({
      platform: "darwin",
      env: {
        npm_config_global: "true",
        OPENCLAW_SKIP_POSTINSTALL_GATEWAY_REPAIR: "1",
      },
      launchAgentFiles: ["ai.openclaw.gateway.plist"],
    });

    expect(shouldRun).toBe(false);
  });

  it("swallows repair errors so npm update does not fail", async () => {
    readdirMock.mockResolvedValue(["ai.openclaw.gateway.plist"]);
    maybeRepairGatewayServiceConfigMock.mockRejectedValue(new Error("bootstrap failed"));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const result = await runPostinstallGatewayServiceRepair({
      platform: "darwin",
      env: {
        HOME: "/Users/test",
        npm_config_global: "true",
      },
      runtime,
    });

    expect(result).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("LaunchAgent repair skipped: bootstrap failed"),
    );
  });
});
