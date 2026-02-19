import { beforeEach, describe, expect, it, vi } from "vitest";
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

function makeDoctorIo() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function makeDoctorPrompts() {
  return {
    confirm: vi.fn().mockResolvedValue(true),
    confirmRepair: vi.fn().mockResolvedValue(true),
    confirmAggressive: vi.fn().mockResolvedValue(true),
    confirmSkipInNonInteractive: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue("node"),
    shouldRepair: false,
    shouldForce: false,
  };
}

async function runRepair(cfg: OpenClawConfig) {
  await maybeRepairGatewayServiceConfig(cfg, "local", makeDoctorIo(), makeDoctorPrompts());
}

const gatewayProgramArguments = [
  "/usr/bin/node",
  "/usr/local/bin/openclaw",
  "gateway",
  "--port",
  "18789",
];

function setupGatewayTokenRepairScenario(expectedToken: string) {
  mocks.readCommand.mockResolvedValue({
    programArguments: gatewayProgramArguments,
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
    programArguments: gatewayProgramArguments,
    workingDirectory: "/tmp",
    environment: {
      OPENCLAW_GATEWAY_TOKEN: expectedToken,
    },
  });
  mocks.install.mockResolvedValue(undefined);
}

describe("maybeRepairGatewayServiceConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats gateway.auth.token as source of truth for service token repairs", async () => {
    setupGatewayTokenRepairScenario("config-token");

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "config-token",
        },
      },
    };

    await runRepair(cfg);

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

  it("uses OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    try {
      setupGatewayTokenRepairScenario("env-token");

      const cfg: OpenClawConfig = {
        gateway: {},
      };

      await runRepair(cfg);

      expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedGatewayToken: "env-token",
        }),
      );
      expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "env-token",
        }),
      );
      expect(mocks.install).toHaveBeenCalledTimes(1);
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }
  });
});
