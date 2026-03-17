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
  runGatewayStartupPluginBootstrapPhase,
  runGatewayStartupRuntimeConfigPhase,
  runGatewayStartupRuntimePolicyPhase,
  runGatewayStartupSecretsPrecheck,
  runGatewayStartupDiscoveryPhase,
  runGatewayStartupSidecarPhase,
  runGatewayStartupTailscaleExposurePhase,
  runGatewayStartupTransportBootstrapPhase,
  runGatewayStartupTlsRuntimePhase,
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

  it("classifies secrets precheck activation failures", async () => {
    const snapshot = createSnapshot();
    const activateRuntimeSecrets = vi
      .fn<(config: OpenClawConfig) => Promise<void>>()
      .mockRejectedValue(new Error("missing OPENAI_API_KEY"));

    await expect(
      runGatewayStartupSecretsPrecheck({
        context: createGatewayStartupContext(snapshot),
        readSnapshot: vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(snapshot),
        prepareConfig: vi.fn<(config: OpenClawConfig) => OpenClawConfig>().mockReturnValue({}),
        activateRuntimeSecrets,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "secrets_precheck",
        message: "missing OPENAI_API_KEY",
      }),
    );
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

  it("classifies auth bootstrap failures", async () => {
    await expect(
      runGatewayStartupAuthBootstrap({
        loadConfig: () => ({}),
        context: createGatewayStartupContext(createSnapshot()),
        ensureGatewayStartupAuth: vi.fn().mockRejectedValue(new Error("auth bootstrap failed")),
        activateRuntimeSecrets: vi.fn().mockResolvedValue({ config: {} }),
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "auth_bootstrap",
        message: "auth bootstrap failed",
      }),
    );
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

  it("classifies runtime policy failures", async () => {
    await expect(
      runGatewayStartupRuntimePolicyPhase({
        context: createGatewayStartupContext(createSnapshot()),
        isDiagnosticsEnabled: () => false,
        startDiagnosticHeartbeat: vi.fn(),
        isRestartEnabled: () => false,
        setGatewaySigusr1RestartPolicy: vi.fn(),
        setPreRestartDeferralCheck: vi.fn(),
        getPendingWorkCount: () => 0,
        seedControlUiAllowedOrigins: vi.fn().mockRejectedValue(new Error("seed failed")),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "runtime_policy",
        message: "seed failed",
      }),
    );
  });
});

describe("runGatewayStartupPluginBootstrapPhase", () => {
  it("returns plugin bootstrap result on success", async () => {
    const pluginBootstrap = {
      pluginRegistry: { gatewayHandlers: {}, close: async () => {} },
      gatewayMethods: ["health", "chat.send"],
    };

    const result = await runGatewayStartupPluginBootstrapPhase({
      loadPlugins: vi.fn().mockReturnValue(pluginBootstrap),
    });

    expect(result).toBe(pluginBootstrap);
  });

  it("classifies plugin bootstrap failures", async () => {
    const failure = new Error("plugin manifest failed");

    await expect(
      runGatewayStartupPluginBootstrapPhase({
        loadPlugins: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "plugin_bootstrap",
        message: "plugin manifest failed",
      }),
    );
  });
});

describe("runGatewayStartupTlsRuntimePhase", () => {
  it("returns tls runtime on success", async () => {
    const tlsRuntime = { enabled: true, server: null };
    const result = await runGatewayStartupTlsRuntimePhase({
      loadTlsRuntime: vi.fn().mockResolvedValue(tlsRuntime),
    });

    expect(result).toBe(tlsRuntime);
  });

  it("classifies tls runtime resolution failures", async () => {
    await expect(
      runGatewayStartupTlsRuntimePhase({
        loadTlsRuntime: vi.fn().mockRejectedValue(new Error("tls cert missing")),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "tls_runtime_resolution",
        message: "tls cert missing",
      }),
    );
  });
});

describe("runGatewayStartupTransportBootstrapPhase", () => {
  it("returns transport runtime on success", async () => {
    const transportRuntime = { httpServer: {}, wss: {} };
    const result = await runGatewayStartupTransportBootstrapPhase({
      bootstrapTransport: vi.fn().mockResolvedValue(transportRuntime),
    });

    expect(result).toBe(transportRuntime);
  });

  it("classifies transport bootstrap failures", async () => {
    await expect(
      runGatewayStartupTransportBootstrapPhase({
        bootstrapTransport: vi.fn().mockRejectedValue(new Error("address already in use")),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "transport_bootstrap",
        message: "address already in use",
      }),
    );
  });
});

describe("runGatewayStartupSidecarPhase", () => {
  it("returns sidecar runtime on success", async () => {
    const sidecarRuntime = { browserControl: {}, pluginServices: null };
    const result = await runGatewayStartupSidecarPhase({
      startSidecars: vi.fn().mockResolvedValue(sidecarRuntime),
    });

    expect(result).toBe(sidecarRuntime);
  });

  it("classifies sidecar startup failures", async () => {
    await expect(
      runGatewayStartupSidecarPhase({
        startSidecars: vi.fn().mockRejectedValue(new Error("browser control failed")),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "sidecar_startup",
        message: "browser control failed",
      }),
    );
  });
});

describe("runGatewayStartupDiscoveryPhase", () => {
  it("returns discovery runtime on success", async () => {
    const discoveryRuntime = { bonjourStop: vi.fn(async () => {}) };
    const result = await runGatewayStartupDiscoveryPhase({
      startDiscovery: vi.fn().mockResolvedValue(discoveryRuntime),
    });

    expect(result).toBe(discoveryRuntime);
  });

  it("classifies discovery startup failures", async () => {
    await expect(
      runGatewayStartupDiscoveryPhase({
        startDiscovery: vi.fn().mockRejectedValue(new Error("mdns bind failed")),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "discovery_startup",
        message: "mdns bind failed",
      }),
    );
  });
});

describe("runGatewayStartupTailscaleExposurePhase", () => {
  it("returns tailscale cleanup on success", async () => {
    const tailscaleCleanup = vi.fn(async () => {});
    const result = await runGatewayStartupTailscaleExposurePhase({
      startTailscaleExposure: vi.fn().mockResolvedValue(tailscaleCleanup),
    });

    expect(result).toBe(tailscaleCleanup);
  });

  it("classifies tailscale exposure failures", async () => {
    await expect(
      runGatewayStartupTailscaleExposurePhase({
        startTailscaleExposure: vi.fn().mockRejectedValue(new Error("tailscale serve failed")),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "tailscale_exposure",
        message: "tailscale serve failed",
      }),
    );
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
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "runtime_config_resolution",
        message: "runtime config failed",
      }),
    );
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
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayStartupPreflightError>>({
        phase: "control_ui_root_resolution",
        message: "control ui root failed",
      }),
    );
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

  it("classifies serialized runtime startup phase errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "runtime_config_resolution",
      message: "runtime config failed",
    });

    expect(classified).toEqual({
      phase: "runtime_config_resolution",
      message: "runtime config failed",
    });
  });

  it("classifies serialized plugin bootstrap startup errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "plugin_bootstrap",
      message: "plugin bootstrap failed",
    });

    expect(classified).toEqual({
      phase: "plugin_bootstrap",
      message: "plugin bootstrap failed",
    });
  });

  it("classifies serialized auth bootstrap startup phase errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "auth_bootstrap",
      message: "auth bootstrap failed",
    });

    expect(classified).toEqual({
      phase: "auth_bootstrap",
      message: "auth bootstrap failed",
    });
  });

  it("classifies serialized tls startup phase errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "tls_runtime_resolution",
      message: "tls cert missing",
    });

    expect(classified).toEqual({
      phase: "tls_runtime_resolution",
      message: "tls cert missing",
    });
  });

  it("classifies serialized transport bootstrap errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "transport_bootstrap",
      message: "address already in use",
    });

    expect(classified).toEqual({
      phase: "transport_bootstrap",
      message: "address already in use",
    });
  });

  it("classifies serialized sidecar startup errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "sidecar_startup",
      message: "browser control failed",
    });

    expect(classified).toEqual({
      phase: "sidecar_startup",
      message: "browser control failed",
    });
  });

  it("classifies serialized discovery startup errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "discovery_startup",
      message: "mdns bind failed",
    });

    expect(classified).toEqual({
      phase: "discovery_startup",
      message: "mdns bind failed",
    });
  });

  it("classifies serialized tailscale exposure errors", () => {
    const classified = classifyGatewayStartupPreflightError({
      name: "GatewayStartupPreflightError",
      phase: "tailscale_exposure",
      message: "tailscale serve failed",
    });

    expect(classified).toEqual({
      phase: "tailscale_exposure",
      message: "tailscale serve failed",
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

  it("formats classified runtime startup phase failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "control_ui_root_resolution",
        message: "control ui root failed",
      }),
    ).toBe("Gateway startup phase failed (control_ui_root_resolution): control ui root failed");
  });

  it("formats classified plugin bootstrap failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "plugin_bootstrap",
        message: "plugin bootstrap failed",
      }),
    ).toBe("Gateway startup phase failed (plugin_bootstrap): plugin bootstrap failed");
  });

  it("formats classified auth bootstrap failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "auth_bootstrap",
        message: "auth bootstrap failed",
      }),
    ).toBe("Gateway startup phase failed (auth_bootstrap): auth bootstrap failed");
  });

  it("formats classified tls startup failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "tls_runtime_resolution",
        message: "tls cert missing",
      }),
    ).toBe("Gateway startup phase failed (tls_runtime_resolution): tls cert missing");
  });

  it("formats classified transport bootstrap failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "transport_bootstrap",
        message: "address already in use",
      }),
    ).toBe("Gateway startup phase failed (transport_bootstrap): address already in use");
  });

  it("formats classified sidecar startup failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "sidecar_startup",
        message: "browser control failed",
      }),
    ).toBe("Gateway startup phase failed (sidecar_startup): browser control failed");
  });

  it("formats classified discovery startup failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "discovery_startup",
        message: "mdns bind failed",
      }),
    ).toBe("Gateway startup phase failed (discovery_startup): mdns bind failed");
  });

  it("formats classified tailscale exposure failures", () => {
    expect(
      formatGatewayStartupPreflightFailure({
        name: "GatewayStartupPreflightError",
        phase: "tailscale_exposure",
        message: "tailscale serve failed",
      }),
    ).toBe("Gateway startup phase failed (tailscale_exposure): tailscale serve failed");
  });

  it("returns null for non-classified failures", () => {
    expect(formatGatewayStartupPreflightFailure(new Error("boom"))).toBeNull();
  });
});
