import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import {
  GatewayStartupPreflightError,
  runGatewayStartupConfigPreflight,
  runGatewayStartupSecretsPrecheck,
} from "./server-startup-preflight.js";

function createSnapshot(overrides: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {},
    valid: true,
    config: {},
    hash: "hash",
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

describe("runGatewayStartupConfigPreflight", () => {
  it("classifies invalid config errors in config_validation phase", async () => {
    const invalid = createSnapshot({
      valid: false,
      issues: [{ path: "gateway.port", message: "Expected number, got string" }],
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(createSnapshot())
      .mockResolvedValueOnce(invalid);

    await expect(
      runGatewayStartupConfigPreflight({
        readSnapshot,
        writeConfig: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
        isNixMode: false,
      }),
    ).rejects.toMatchObject({
      name: "GatewayStartupPreflightError",
      phase: "config_validation",
      message: expect.stringContaining('Run "openclaw doctor"'),
    });
  });

  it("classifies legacy migration failures in Nix mode", async () => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(
      createSnapshot({
        legacyIssues: [{ path: "routing.allowFrom", message: "legacy key" }],
      }),
    );
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>();

    await expect(
      runGatewayStartupConfigPreflight({
        readSnapshot,
        writeConfig,
        log: { info: vi.fn(), warn: vi.fn() },
        isNixMode: true,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "config_legacy_migration",
      }),
    );

    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("writes auto-enabled plugins and re-reads snapshot on success", async () => {
    const phaseTwo = createSnapshot({
      config: { plugins: { msteams: { enabled: false } } },
    });
    const phaseThree = createSnapshot({
      config: { plugins: { msteams: { enabled: true } } },
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(createSnapshot())
      .mockResolvedValueOnce(phaseTwo)
      .mockResolvedValueOnce(phaseThree);
    const writeConfig = vi.fn<(config: OpenClawConfig) => Promise<void>>().mockResolvedValue();
    const info = vi.fn<(message: string) => void>();

    const result = await runGatewayStartupConfigPreflight({
      readSnapshot,
      writeConfig,
      log: { info, warn: vi.fn() },
      isNixMode: false,
      applyPluginAutoEnableFn: () => ({
        config: phaseThree.config,
        changes: ["plugins.msteams.enabled"],
      }),
    });

    expect(writeConfig).toHaveBeenCalledWith(phaseThree.config);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("auto-enabled plugins"));
    expect(result).toBe(phaseThree);
  });
});

describe("runGatewayStartupSecretsPrecheck", () => {
  it("classifies invalid config errors before secrets activation", async () => {
    const invalid = createSnapshot({
      valid: false,
      issues: [{ path: "auth.profile", message: "Missing profile" }],
    });
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(invalid);
    const prepareConfig = vi.fn<(config: OpenClawConfig) => OpenClawConfig>();
    const activateRuntimeSecrets = vi.fn<(config: OpenClawConfig) => Promise<void>>();

    await expect(
      runGatewayStartupSecretsPrecheck({
        readSnapshot,
        prepareConfig,
        activateRuntimeSecrets,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "config_validation",
        message: expect.stringContaining("Invalid config at /tmp/openclaw.json"),
      }),
    );

    expect(prepareConfig).not.toHaveBeenCalled();
    expect(activateRuntimeSecrets).not.toHaveBeenCalled();
  });

  it("prepares config and runs secrets precheck for valid snapshots", async () => {
    const snapshot = createSnapshot({
      config: { auth: { profile: "default" } },
    });
    const preparedConfig: OpenClawConfig = { auth: { profile: "gateway" } };
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(snapshot);
    const prepareConfig = vi
      .fn<(config: OpenClawConfig) => OpenClawConfig>()
      .mockReturnValue(preparedConfig);
    const activateRuntimeSecrets = vi
      .fn<(config: OpenClawConfig) => Promise<void>>()
      .mockResolvedValue();

    await runGatewayStartupSecretsPrecheck({
      readSnapshot,
      prepareConfig,
      activateRuntimeSecrets,
    });

    expect(prepareConfig).toHaveBeenCalledWith(snapshot.config);
    expect(activateRuntimeSecrets).toHaveBeenCalledWith(preparedConfig);
  });
});
