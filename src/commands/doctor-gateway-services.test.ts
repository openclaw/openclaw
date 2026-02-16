import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  install: vi.fn(),
  auditGatewayServiceConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveIsNixMode: vi.fn(() => false),
  note: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: mocks.resolveGatewayPort,
  resolveIsNixMode: mocks.resolveIsNixMode,
}));

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices: vi.fn().mockResolvedValue([]),
  renderGatewayServiceCleanupHints: vi.fn().mockReturnValue([]),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: vi.fn().mockReturnValue(undefined),
  resolveSystemNodeInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: mocks.auditGatewayServiceConfig,
  needsNodeRuntimeMigration: vi.fn(() => false),
  SERVICE_AUDIT_CODES: {
    gatewayEntrypointMismatch: "gateway-entrypoint-mismatch",
  },
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    readCommand: mocks.readCommand,
    install: mocks.install,
  }),
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";

describe("maybeRepairGatewayServiceConfig", () => {
  it("treats gateway.auth.token as source of truth for service token repairs", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-token",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-token-mismatch",
          message: "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "config-token",
      },
    });
    mocks.install.mockResolvedValue(undefined);

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "config-token",
        },
      },
    };

    await maybeRepairGatewayServiceConfig(
      cfg,
      "local",
      { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      {
        confirm: vi.fn().mockResolvedValue(true),
        confirmRepair: vi.fn().mockResolvedValue(true),
        confirmAggressive: vi.fn().mockResolvedValue(true),
        confirmSkipInNonInteractive: vi.fn().mockResolvedValue(true),
        select: vi.fn().mockResolvedValue("node"),
        shouldRepair: false,
        shouldForce: false,
      },
    );

    expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGatewayToken: "config-token",
      }),
    );
    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "config-token",
      }),
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });
});
