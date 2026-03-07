import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  install: vi.fn(),
  auditGatewayServiceConfig: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  resolveGatewayInstallToken: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  resolveIsNixMode: vi.fn(() => false),
  findExtraGatewayServices: vi.fn().mockResolvedValue([]),
  renderGatewayServiceCleanupHints: vi.fn().mockReturnValue([]),
  uninstallLegacySystemdUnits: vi.fn().mockResolvedValue([]),
  // Default: gateway service not running, companion services not active
  isSystemdUnitActive: vi.fn().mockResolvedValue(false),
  note: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: mocks.resolveGatewayPort,
  resolveIsNixMode: mocks.resolveIsNixMode,
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
  SERVICE_AUDIT_CODES: {
    gatewayCommandMissing: "gateway-command-missing",
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
  isSystemdUnitActive: (...args: unknown[]) => mocks.isSystemdUnitActive(...args),
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken: mocks.resolveGatewayInstallToken,
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
  mocks.resolveGatewayInstallToken.mockResolvedValue({
    token: expectedToken,
    tokenRefConfigured: false,
    warnings: [],
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
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
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
    });
  });

  it("treats SecretRef-managed gateway token as non-persisted service state", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-token",
      },
    });
    mocks.resolveGatewayInstallToken.mockResolvedValue({
      token: undefined,
      tokenRefConfigured: true,
      warnings: [],
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
        token: undefined,
      }),
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
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

describe("maybeRepairGatewayServiceConfig — running gateway protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips ExecStart-level issues when the gateway service is currently running", async () => {
    // Simulate a custom wrapper script as ExecStart: doctor flags gateway-command-missing
    // because the shell script doesn't pass "gateway" as a subcommand argument.
    mocks.readCommand.mockResolvedValue({
      programArguments: ["/home/user/.local/bin/openclaw-gateway-start"],
      sourcePath: "/home/user/.config/systemd/user/openclaw-gateway.service",
      environment: { OPENCLAW_GATEWAY_TOKEN: "token" },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-command-missing",
          message: "Service command does not include the gateway subcommand",
          level: "aggressive",
        },
      ],
    });
    mocks.resolveGatewayInstallToken.mockResolvedValue({
      token: "token",
      tokenRefConfigured: false,
      warnings: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/path/to/openclaw", "gateway"],
      workingDirectory: "/tmp",
      environment: {},
    });

    // Gateway is running — ExecStart repair must be skipped
    mocks.isSystemdUnitActive.mockResolvedValue(true);

    await runRepair({});

    // install should NOT have been called — no remaining issues after filtering
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("proceeds with ExecStart repair when the gateway service is not running", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: ["/home/user/.local/bin/openclaw-gateway-start"],
      sourcePath: "/home/user/.config/systemd/user/openclaw-gateway.service",
      environment: { OPENCLAW_GATEWAY_TOKEN: "token" },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-command-missing",
          message: "Service command does not include the gateway subcommand",
          level: "aggressive",
        },
      ],
    });
    mocks.resolveGatewayInstallToken.mockResolvedValue({
      token: "token",
      tokenRefConfigured: false,
      warnings: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/path/to/openclaw", "gateway"],
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.install.mockResolvedValue(undefined);

    // Gateway is NOT running — repair is allowed to proceed
    mocks.isSystemdUnitActive.mockResolvedValue(false);

    await runRepair({});

    expect(mocks.install).toHaveBeenCalledTimes(1);
  });
});

describe("maybeScanExtraGatewayServices — active-only filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findExtraGatewayServices.mockResolvedValue([]);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([]);
    mocks.isSystemdUnitActive.mockResolvedValue(false);
  });

  function makePrompts() {
    return {
      confirm: vi.fn(),
      confirmRepair: vi.fn(),
      confirmAggressive: vi.fn(),
      confirmSkipInNonInteractive: vi.fn().mockResolvedValue(false),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
    };
  }

  it("does not warn about inactive extra services (e.g. a stopped companion)", async () => {
    mocks.findExtraGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "openclaw-voice.service",
        detail: "unit: /home/user/.config/systemd/user/openclaw-voice.service",
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
    // Service is not active
    mocks.isSystemdUnitActive.mockResolvedValue(false);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await maybeScanExtraGatewayServices({ deep: false }, runtime, makePrompts());

    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.any(String),
      "Other gateway-like services detected",
    );
  });

  it("warns about an extra service that is actively running", async () => {
    mocks.findExtraGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "openclaw-gateway-second.service",
        detail: "unit: /home/user/.config/systemd/user/openclaw-gateway-second.service",
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
    // Service IS active
    mocks.isSystemdUnitActive.mockResolvedValue(true);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await maybeScanExtraGatewayServices({ deep: false }, runtime, makePrompts());

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-gateway-second.service"),
      "Other gateway-like services detected",
    );
  });
});
