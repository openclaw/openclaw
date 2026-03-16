import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import {
  classifyGatewayStartupPreflightError,
  createGatewayStartupContext,
  formatGatewayStartupPreflightFailure,
  runGatewayStartupAuthBootstrap,
  runGatewayStartupControlUiRootPhase,
  GatewayStartupPreflightError,
  runGatewayStartupConfigPreflight,
  runGatewayStartupRuntimeConfigPhase,
  runGatewayStartupRuntimePolicyPhase,
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
    expect(result).toEqual(
      expect.objectContaining({
        preflightSnapshot: phaseThree,
        config: phaseThree.config,
      }),
    );
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
        context: createGatewayStartupContext(createSnapshot()),
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

    const result = await runGatewayStartupSecretsPrecheck({
      context: createGatewayStartupContext(snapshot),
      readSnapshot,
      prepareConfig,
      activateRuntimeSecrets,
    });

    expect(prepareConfig).toHaveBeenCalledWith(snapshot.config);
    expect(activateRuntimeSecrets).toHaveBeenCalledWith(preparedConfig);
    expect(result.secretsPrechecked).toBe(true);
    expect(result.config).toEqual(snapshot.config);
  });
});

describe("runGatewayStartupAuthBootstrap", () => {
  it("passes overrides into startup auth bootstrap and returns activated config", async () => {
    const initialConfig: OpenClawConfig = { gateway: { auth: { mode: "token" } } };
    const authConfig: OpenClawConfig = { gateway: { auth: { mode: "token", token: "abc123" } } };
    const activatedConfig: OpenClawConfig = { gateway: { auth: { mode: "none" } } };
    const env = { OPENCLAW_GATEWAY_PORT: "18789" } as NodeJS.ProcessEnv;
    const ensureGatewayStartupAuth = vi
      .fn<
        (params: {
          cfg: OpenClawConfig;
          env: NodeJS.ProcessEnv;
          authOverride?: unknown;
          tailscaleOverride?: unknown;
          persist: true;
        }) => Promise<{
          cfg: OpenClawConfig;
          generatedToken?: string;
          persistedGeneratedToken: boolean;
        }>
      >()
      .mockResolvedValue({
        cfg: authConfig,
        persistedGeneratedToken: false,
      });
    const activateRuntimeSecrets = vi
      .fn<(config: OpenClawConfig) => Promise<{ config: OpenClawConfig }>>()
      .mockResolvedValue({ config: activatedConfig });
    const authOverride = { mode: "token", token: "override" };
    const tailscaleOverride = { enabled: true };

    const result = await runGatewayStartupAuthBootstrap({
      loadConfig: () => initialConfig,
      context: createGatewayStartupContext(createSnapshot({ config: initialConfig })),
      ensureGatewayStartupAuth,
      activateRuntimeSecrets,
      log: { info: vi.fn(), warn: vi.fn() },
      env,
      authOverride,
      tailscaleOverride,
    });

    expect(ensureGatewayStartupAuth).toHaveBeenCalledWith({
      cfg: initialConfig,
      env,
      authOverride,
      tailscaleOverride,
      persist: true,
    });
    expect(activateRuntimeSecrets).toHaveBeenCalledWith(authConfig);
    expect(result.config).toBe(activatedConfig);
  });

  it("logs info when token generation is persisted", async () => {
    const info = vi.fn<(message: string) => void>();
    const warn = vi.fn<(message: string) => void>();

    await runGatewayStartupAuthBootstrap({
      loadConfig: () => ({}),
      context: createGatewayStartupContext(createSnapshot()),
      ensureGatewayStartupAuth: vi.fn().mockResolvedValue({
        cfg: {},
        generatedToken: "generated",
        persistedGeneratedToken: true,
      }),
      activateRuntimeSecrets: vi.fn().mockResolvedValue({ config: {} }),
      log: { info, warn },
    });

    expect(info).toHaveBeenCalledWith(
      "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs warning when token generation is runtime-only", async () => {
    const info = vi.fn<(message: string) => void>();
    const warn = vi.fn<(message: string) => void>();

    await runGatewayStartupAuthBootstrap({
      loadConfig: () => ({}),
      context: createGatewayStartupContext(createSnapshot()),
      ensureGatewayStartupAuth: vi.fn().mockResolvedValue({
        cfg: {},
        generatedToken: "generated",
        persistedGeneratedToken: false,
      }),
      activateRuntimeSecrets: vi.fn().mockResolvedValue({ config: {} }),
      log: { info, warn },
    });

    expect(warn).toHaveBeenCalledWith(
      "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
    );
    expect(info).not.toHaveBeenCalled();
  });
});

describe("runGatewayStartupRuntimePolicyPhase", () => {
  it("enables diagnostics and applies runtime policies", async () => {
    const config: OpenClawConfig = { gateway: { diagnostics: { enabled: true } } };
    const seededConfig: OpenClawConfig = {
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: { allowedOrigins: ["https://example.com"] },
      },
    };
    const startDiagnosticHeartbeat = vi.fn<() => void>();
    const setGatewaySigusr1RestartPolicy = vi.fn<(opts: { allowExternal: boolean }) => void>();
    const setPreRestartDeferralCheck = vi.fn<(check: () => number) => void>();
    const getPendingWorkCount = vi.fn<() => number>().mockReturnValue(7);
    const seedControlUiAllowedOrigins = vi
      .fn<(nextConfig: OpenClawConfig) => Promise<OpenClawConfig>>()
      .mockResolvedValue(seededConfig);

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot({ config })),
      isDiagnosticsEnabled: () => true,
      startDiagnosticHeartbeat,
      isRestartEnabled: () => true,
      setGatewaySigusr1RestartPolicy,
      setPreRestartDeferralCheck,
      getPendingWorkCount,
      seedControlUiAllowedOrigins,
    });

    expect(startDiagnosticHeartbeat).toHaveBeenCalledTimes(1);
    expect(setGatewaySigusr1RestartPolicy).toHaveBeenCalledWith({ allowExternal: true });
    expect(setPreRestartDeferralCheck).toHaveBeenCalledTimes(1);
    expect(setPreRestartDeferralCheck.mock.calls[0]?.[0]()).toBe(7);
    expect(seedControlUiAllowedOrigins).toHaveBeenCalledWith(config);
    expect(result).toEqual(
      expect.objectContaining({
        config: seededConfig,
        diagnosticsEnabled: true,
      }),
    );
  });

  it("does not start diagnostics when disabled", async () => {
    const startDiagnosticHeartbeat = vi.fn<() => void>();

    const result = await runGatewayStartupRuntimePolicyPhase({
      context: createGatewayStartupContext(createSnapshot()),
      isDiagnosticsEnabled: () => false,
      startDiagnosticHeartbeat,
      isRestartEnabled: () => false,
      setGatewaySigusr1RestartPolicy: vi.fn(),
      setPreRestartDeferralCheck: vi.fn(),
      getPendingWorkCount: () => 0,
      seedControlUiAllowedOrigins: async (config) => config,
    });

    expect(startDiagnosticHeartbeat).not.toHaveBeenCalled();
    expect(result.diagnosticsEnabled).toBe(false);
  });
});

describe("runGatewayStartupRuntimeConfigPhase", () => {
  it("stores resolved runtime config and preserves prior context fields", async () => {
    const baseSnapshot = createSnapshot({ config: { gateway: { bind: "loopback" } } });
    const baseContext = {
      ...createGatewayStartupContext(baseSnapshot),
      secretsPrechecked: true,
      diagnosticsEnabled: true,
    };
    const runtimeConfig = {
      bindHost: "127.0.0.1",
      controlUiEnabled: true,
      openAiChatCompletionsEnabled: false,
      openAiChatCompletionsConfig: {},
      openResponsesEnabled: false,
      openResponsesConfig: {},
      strictTransportSecurityHeader: undefined,
      controlUiBasePath: "/control",
      controlUiRoot: undefined,
      resolvedAuth: { mode: "none" },
      tailscaleConfig: undefined,
      tailscaleMode: "off",
      hooksConfig: {},
      canvasHostEnabled: false,
    };

    const result = await runGatewayStartupRuntimeConfigPhase({
      context: baseContext,
      resolveRuntimeConfig: vi.fn().mockResolvedValue(runtimeConfig),
    });

    expect(result.runtimeConfig).toBe(runtimeConfig);
    expect(result.config).toBe(baseContext.config);
    expect(result.secretsPrechecked).toBe(true);
    expect(result.diagnosticsEnabled).toBe(true);
  });

  it("propagates runtime config resolution failures", async () => {
    const failure = new Error("runtime config failed");

    await expect(
      runGatewayStartupRuntimeConfigPhase({
        context: createGatewayStartupContext(createSnapshot()),
        resolveRuntimeConfig: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
  });
});

describe("runGatewayStartupControlUiRootPhase", () => {
  it("stores resolved control-ui root state and preserves runtime config context", async () => {
    const baseSnapshot = createSnapshot();
    const runtimeConfig = {
      bindHost: "127.0.0.1",
      controlUiEnabled: true,
      openAiChatCompletionsEnabled: false,
      openAiChatCompletionsConfig: {},
      openResponsesEnabled: false,
      openResponsesConfig: {},
      strictTransportSecurityHeader: undefined,
      controlUiBasePath: "/control",
      controlUiRoot: undefined,
      resolvedAuth: { mode: "none" },
      tailscaleConfig: undefined,
      tailscaleMode: "off",
      hooksConfig: {},
      canvasHostEnabled: false,
    };
    const context = {
      ...createGatewayStartupContext(baseSnapshot),
      runtimeConfig,
    };
    const controlUiRootState = {
      source: "absolute-path",
      absolutePath: "/tmp/control-ui",
      diagnostics: [],
    };

    const result = await runGatewayStartupControlUiRootPhase({
      context,
      resolveControlUiRootState: vi.fn().mockResolvedValue(controlUiRootState),
    });

    expect(result.runtimeConfig).toBe(runtimeConfig);
    expect(result.controlUiRootState).toBe(controlUiRootState);
  });

  it("propagates control-ui root resolution failures", async () => {
    const runtimeConfig = {
      bindHost: "127.0.0.1",
      controlUiEnabled: true,
      openAiChatCompletionsEnabled: false,
      openAiChatCompletionsConfig: {},
      openResponsesEnabled: false,
      openResponsesConfig: {},
      strictTransportSecurityHeader: undefined,
      controlUiBasePath: "/control",
      controlUiRoot: undefined,
      resolvedAuth: { mode: "none" },
      tailscaleConfig: undefined,
      tailscaleMode: "off",
      hooksConfig: {},
      canvasHostEnabled: false,
    };
    const failure = new Error("control ui root failed");

    await expect(
      runGatewayStartupControlUiRootPhase({
        context: {
          ...createGatewayStartupContext(createSnapshot()),
          runtimeConfig,
        },
        resolveControlUiRootState: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
  });
});

describe("classifyGatewayStartupPreflightError", () => {
  it("classifies concrete startup preflight errors", () => {
    const classified = classifyGatewayStartupPreflightError(
      new GatewayStartupPreflightError("config_validation", "bad config"),
    );

    expect(classified).toEqual({
      phase: "config_validation",
      message: "bad config",
    });
  });

  it("classifies serialized startup preflight errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "config_legacy_migration",
      message: "legacy keys",
    });

    expect(classified).toEqual({
      phase: "config_legacy_migration",
      message: "legacy keys",
    });
  });

  it("returns null for non-preflight errors", () => {
    expect(classifyGatewayStartupPreflightError(new Error("boom"))).toBeNull();
  });
});

describe("formatGatewayStartupPreflightFailure", () => {
  it("formats classified startup phase failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "config_validation",
        message: "Invalid config",
      }),
    ).toBe("Gateway startup phase failed (config_validation): Invalid config");
  });

  it("returns null for non-classified failures", () => {
    expect(formatGatewayStartupPreflightFailure(new Error("boom"))).toBeNull();
  });
});
