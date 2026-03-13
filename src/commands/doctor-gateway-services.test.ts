import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  install: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
  auditGatewayServiceConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  resolveGatewayAuthTokenForService: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveIsNixMode: vi.fn(() => false),
  findExtraGatewayServices: vi.fn().mockResolvedValue([]),
  renderGatewayServiceCleanupHints: vi.fn().mockReturnValue([]),
  uninstallLegacySystemdUnits: vi.fn().mockResolvedValue([]),
  note: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: mocks.resolveGatewayPort,
  resolveIsNixMode: mocks.resolveIsNixMode,
}));

vi.mock("../config/config.js", () => ({
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices: mocks.findExtraGatewayServices,
  renderGatewayServiceCleanupHints: mocks.renderGatewayServiceCleanupHints,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  renderSystemNodeWarning: vi.fn().mockReturnValue(undefined),
  resolveSystemNodeInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: mocks.auditGatewayServiceConfig,
  needsNodeRuntimeMigration: vi.fn(() => false),
  readEmbeddedGatewayToken: (
    command: {
      environment?: Record<string, string>;
      environmentValueSources?: Record<string, "inline" | "file">;
    } | null,
  ) =>
    command?.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN === "file"
      ? undefined
      : command?.environment?.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined,
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

vi.mock("../daemon/systemd.js", () => ({
  uninstallLegacySystemdUnits: mocks.uninstallLegacySystemdUnits,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

vi.mock("./doctor-gateway-auth-token.js", () => ({
  resolveGatewayAuthTokenForService: mocks.resolveGatewayAuthTokenForService,
}));

import {
  maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";

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

function setupGatewayTokenRepairScenario() {
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
    environment: {},
  });
  mocks.install.mockResolvedValue(undefined);
}

describe("maybeRepairGatewayServiceConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveGatewayAuthTokenForService.mockImplementation(async (cfg: OpenClawConfig, env) => {
      const configToken =
        typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway.auth.token.trim() : undefined;
      const envToken = env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
      return { token: configToken || envToken };
    });
  });

  it("treats gateway.auth.token as source of truth for service token repairs", async () => {
    setupGatewayTokenRepairScenario();

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
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: "config-token",
            }),
          }),
        }),
      }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("uses OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      setupGatewayTokenRepairScenario();

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
          config: expect.objectContaining({
            gateway: expect.objectContaining({
              auth: expect.objectContaining({
                token: "env-token",
              }),
            }),
          }),
        }),
      );
      expect(mocks.writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          gateway: expect.objectContaining({
            auth: expect.objectContaining({
              token: "env-token",
            }),
          }),
        }),
      );
      expect(mocks.install).toHaveBeenCalledTimes(1);
    });
  });

  it("does not attempt entrypoint repair when the shared audit is clean", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: [
        "/usr/bin/node",
        "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      environment: {},
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });

    await runRepair({ gateway: {} });

    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(mocks.buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("still flags entrypoint mismatch when the shared audit reports it", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: [
        "/usr/bin/node",
        "/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      environment: {},
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-entrypoint-mismatch",
          message: "Gateway service entrypoint does not match the current install.",
          detail:
            "/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/openclaw/dist/index.js -> /Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: [
        "/usr/bin/node",
        "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.install.mockResolvedValue(undefined);

    await runRepair({ gateway: {} });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service entrypoint does not match the current install."),
      "Gateway service config",
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("treats SecretRef-managed gateway token as non-persisted service state", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-token",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.install.mockResolvedValue(undefined);

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_GATEWAY_TOKEN",
          },
        },
      },
    };

    await runRepair(cfg);

    expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGatewayToken: undefined,
      }),
    );
    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
      }),
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("falls back to embedded service token when config and env tokens are missing", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        CLAWDBOT_GATEWAY_TOKEN: undefined,
      },
      async () => {
        setupGatewayTokenRepairScenario();

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedGatewayToken: undefined,
          }),
        );
        expect(mocks.writeConfigFile).toHaveBeenCalledWith(
          expect.objectContaining({
            gateway: expect.objectContaining({
              auth: expect.objectContaining({
                token: "stale-token",
              }),
            }),
          }),
        );
        expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              gateway: expect.objectContaining({
                auth: expect.objectContaining({
                  token: "stale-token",
                }),
              }),
            }),
          }),
        );
        expect(mocks.install).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("does not persist EnvironmentFile-backed service tokens into config", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        CLAWDBOT_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mocks.readCommand.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "env-file-token",
          },
          environmentValueSources: {
            OPENCLAW_GATEWAY_TOKEN: "file",
          },
        });
        mocks.auditGatewayServiceConfig.mockResolvedValue({
          ok: false,
          issues: [
            {
              code: "gateway-token-embedded",
              message: "Gateway service embeds OPENCLAW_GATEWAY_TOKEN and should be reinstalled.",
              level: "recommended",
            },
          ],
        });
        mocks.buildGatewayInstallPlan.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          workingDirectory: "/tmp",
          environment: {},
        });
        mocks.install.mockResolvedValue(undefined);

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expect(mocks.writeConfigFile).not.toHaveBeenCalled();
        expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
          expect.objectContaining({
            config: cfg,
          }),
        );
      },
    );
  });
});

describe("maybeScanExtraGatewayServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findExtraGatewayServices.mockResolvedValue([]);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([]);
  });

  it("removes legacy Linux user systemd services", async () => {
    mocks.findExtraGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "moltbot-gateway.service",
        detail: "unit: /home/test/.config/systemd/user/moltbot-gateway.service",
        scope: "user",
        legacy: true,
      },
    ]);
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([
      {
        name: "moltbot-gateway",
        unitPath: "/home/test/.config/systemd/user/moltbot-gateway.service",
        enabled: true,
        exists: true,
      },
    ]);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const prompter = {
      confirm: vi.fn(),
      confirmRepair: vi.fn(),
      confirmAggressive: vi.fn(),
      confirmSkipInNonInteractive: vi.fn().mockResolvedValue(true),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
    };

    await maybeScanExtraGatewayServices({ deep: false }, runtime, prompter);

    expect(mocks.uninstallLegacySystemdUnits).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallLegacySystemdUnits).toHaveBeenCalledWith({
      env: process.env,
      stdout: process.stdout,
    });
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("moltbot-gateway.service"),
      "Legacy gateway removed",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Legacy gateway services removed. Installing OpenClaw gateway next.",
    );
  });
});
