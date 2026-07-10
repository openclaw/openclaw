import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectDefaultInferenceRoute } from "./inference-route.js";

const setupMocks = vi.hoisted(() => ({
  readSetupConfigFileSnapshot: vi.fn(),
  writeWizardConfigFile: vi.fn(),
  resolveQuickstartGatewayDefaults: vi.fn(),
  applyLocalSetupWorkspaceConfig: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  configureGatewayForSetup: vi.fn(),
  ensureGatewayServiceForOnboarding: vi.fn(),
  resolveLocalControlUiProbeLinks: vi.fn(),
  waitForGatewayReachable: vi.fn(),
  loadExecApprovals: vi.fn(() => ({ agents: {} })),
  saveExecApprovals: vi.fn(),
}));

vi.mock("../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: setupMocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: setupMocks.writeWizardConfigFile,
  resolveQuickstartGatewayDefaults: setupMocks.resolveQuickstartGatewayDefaults,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: setupMocks.ensureWorkspaceAndSessions,
  resolveLocalControlUiProbeLinks: setupMocks.resolveLocalControlUiProbeLinks,
  waitForGatewayReachable: setupMocks.waitForGatewayReachable,
}));

vi.mock("../commands/onboard-config.js", () => ({
  applyLocalSetupWorkspaceConfig: setupMocks.applyLocalSetupWorkspaceConfig,
}));

vi.mock("../wizard/setup.gateway-config.js", () => ({
  configureGatewayForSetup: setupMocks.configureGatewayForSetup,
}));

vi.mock("../wizard/setup.finalize.js", () => ({
  ensureGatewayServiceForOnboarding: setupMocks.ensureGatewayServiceForOnboarding,
}));

vi.mock("../infra/exec-approvals.js", () => ({
  loadExecApprovals: setupMocks.loadExecApprovals,
  saveExecApprovals: setupMocks.saveExecApprovals,
}));

import { applyCrestodianModelSelection, applyCrestodianSetup } from "./setup-apply.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyCrestodianModelSelection", () => {
  it("clears stale harness pins when switching to a native provider route", async () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
        list: [
          {
            id: "work",
            default: true,
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                alias: "primary",
                agentRuntime: { id: "codex" },
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const result = await applyCrestodianModelSelection({
      config,
      model: "openai/gpt-5.5",
    });

    expect(result.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
    expect(result.agents?.list?.[0]?.models?.["openai/gpt-5.5"]).toEqual({ alias: "primary" });
    expect(result.agents?.list?.[0]?.model).toBe("openai/gpt-5.5");
  });
});

describe("applyCrestodianSetup", () => {
  it.each([
    ["missing", false, true],
    ["invalid", true, false],
  ])(
    "rejects a %s config snapshot before rebuilding setup from an empty config",
    async (_label, exists, valid) => {
      setupMocks.readSetupConfigFileSnapshot.mockResolvedValue({
        exists,
        valid,
        hash: "unusable",
        config: {},
        sourceConfig: {},
        runtimeConfig: {},
      });

      await expect(
        applyCrestodianSetup({
          workspace: "/tmp/work",
          surface: "gateway",
          runtime: { log: () => {}, error: () => {}, exit: () => {} },
        }),
      ).rejects.toThrow("missing or invalid");

      expect(setupMocks.applyLocalSetupWorkspaceConfig).not.toHaveBeenCalled();
      expect(setupMocks.configureGatewayForSetup).not.toHaveBeenCalled();
      expect(setupMocks.writeWizardConfigFile).not.toHaveBeenCalled();
      expect(setupMocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
      expect(setupMocks.saveExecApprovals).not.toHaveBeenCalled();
    },
  );

  it("rejects a configured user agent that collides with Crestodian's privileged id", async () => {
    const config = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        list: [{ id: "Crestodian" }],
      },
    } satisfies OpenClawConfig;
    setupMocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "reserved-agent",
      config,
      sourceConfig: config,
      runtimeConfig: config,
    });

    await expect(
      applyCrestodianSetup({
        workspace: "/tmp/work",
        surface: "gateway",
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
      }),
    ).rejects.toThrow('Agent id "crestodian" is reserved');

    expect(setupMocks.writeWizardConfigFile).not.toHaveBeenCalled();
    expect(setupMocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
    expect(setupMocks.saveExecApprovals).not.toHaveBeenCalled();
  });

  it("rejects config drift before workspace or Gateway mutation", async () => {
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    setupMocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "changed-after-verification",
      config,
      sourceConfig: config,
      runtimeConfig: config,
    });

    const expectedInferenceRoute = await projectDefaultInferenceRoute({
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    });

    await expect(
      applyCrestodianSetup({
        workspace: "/tmp/work",
        expectedInferenceRoute,
        surface: "gateway",
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
      }),
    ).rejects.toThrow("changed before setup could start");

    expect(setupMocks.applyLocalSetupWorkspaceConfig).not.toHaveBeenCalled();
    expect(setupMocks.writeWizardConfigFile).not.toHaveBeenCalled();
    expect(setupMocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", false, true],
    ["invalid", true, false],
  ])(
    "rejects a %s config snapshot after a retryable CAS conflict",
    async (_label, exists, valid) => {
      const config = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        gateway: { port: 19000, bind: "lan" },
      } satisfies OpenClawConfig;
      setupMocks.readSetupConfigFileSnapshot
        .mockResolvedValueOnce({
          exists: true,
          valid: true,
          hash: "hash-1",
          config,
          sourceConfig: config,
          runtimeConfig: config,
        })
        .mockResolvedValueOnce({
          exists,
          valid,
          hash: "hash-2",
          config,
          sourceConfig: config,
          runtimeConfig: config,
        });
      setupMocks.applyLocalSetupWorkspaceConfig.mockImplementation(
        (current: OpenClawConfig, workspace: string) => ({
          ...current,
          agents: {
            ...current.agents,
            defaults: { ...current.agents?.defaults, workspace },
          },
        }),
      );
      setupMocks.resolveQuickstartGatewayDefaults.mockReturnValue({
        hasExisting: true,
        port: 19000,
        bind: "lan",
        authMode: "token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      });
      setupMocks.configureGatewayForSetup.mockImplementation(
        async (opts: { nextConfig: OpenClawConfig }) => ({
          nextConfig: opts.nextConfig,
          settings: {
            port: 19000,
            bind: "lan",
            authMode: "token",
            tailscaleMode: "off",
            tailscaleResetOnExit: false,
          },
        }),
      );
      setupMocks.writeWizardConfigFile.mockRejectedValueOnce(
        new ConfigMutationConflictError("config changed since last load", {
          currentHash: "hash-2",
        }),
      );
      const expectedInferenceRoute = await projectDefaultInferenceRoute(config);

      await expect(
        applyCrestodianSetup({
          workspace: "/tmp/work",
          expectedInferenceRoute,
          surface: "gateway",
          runtime: { log: () => {}, error: () => {}, exit: () => {} },
        }),
      ).rejects.toThrow("missing or invalid");

      expect(setupMocks.configureGatewayForSetup).toHaveBeenCalledTimes(1);
      expect(setupMocks.writeWizardConfigFile).toHaveBeenCalledTimes(1);
      expect(setupMocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
      expect(setupMocks.saveExecApprovals).not.toHaveBeenCalled();
    },
  );

  it("rebuilds Gateway settings from the config that wins a CAS retry", async () => {
    const initialConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      gateway: {
        port: 18789,
        bind: "loopback",
        auth: { mode: "token", token: "initial-token" },
        tailscale: { mode: "off" },
      },
    } satisfies OpenClawConfig;
    const concurrentConfig = {
      ...initialConfig,
      gateway: {
        ...initialConfig.gateway,
        port: 19000,
        bind: "lan",
        auth: { mode: "token" as const, token: "concurrent-token" },
      },
    } satisfies OpenClawConfig;
    setupMocks.readSetupConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        hash: "hash-1",
        config: initialConfig,
        sourceConfig: initialConfig,
        runtimeConfig: initialConfig,
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        hash: "hash-2",
        config: concurrentConfig,
        sourceConfig: concurrentConfig,
        runtimeConfig: concurrentConfig,
      });
    setupMocks.applyLocalSetupWorkspaceConfig.mockImplementation(
      (config: OpenClawConfig, workspace: string) => ({
        ...config,
        agents: {
          ...config.agents,
          defaults: { ...config.agents?.defaults, workspace },
        },
      }),
    );
    setupMocks.resolveQuickstartGatewayDefaults.mockImplementation((config: OpenClawConfig) => ({
      hasExisting: true,
      port: config.gateway?.port ?? 18789,
      bind: config.gateway?.bind ?? "loopback",
      authMode: config.gateway?.auth?.mode ?? "token",
      tailscaleMode: config.gateway?.tailscale?.mode ?? "off",
      token: config.gateway?.auth?.token,
      tailscaleResetOnExit: false,
    }));
    setupMocks.configureGatewayForSetup.mockImplementation(
      async (opts: {
        nextConfig: OpenClawConfig;
        quickstartGateway: {
          port: number;
          bind: "loopback" | "lan";
          authMode: "token";
          token?: string;
          tailscaleMode: "off";
        };
      }) => ({
        nextConfig: opts.nextConfig,
        settings: {
          port: opts.quickstartGateway.port,
          bind: opts.quickstartGateway.bind,
          authMode: opts.quickstartGateway.authMode,
          gatewayToken: opts.quickstartGateway.token,
          tailscaleMode: opts.quickstartGateway.tailscaleMode,
          tailscaleResetOnExit: false,
        },
      }),
    );
    setupMocks.writeWizardConfigFile
      .mockRejectedValueOnce(
        new ConfigMutationConflictError("config changed since last load", {
          currentHash: "hash-2",
        }),
      )
      .mockImplementationOnce(async (config: OpenClawConfig) => config);
    setupMocks.ensureGatewayServiceForOnboarding.mockResolvedValue({
      installDaemon: true,
      containerWithoutUserSystemd: false,
    });
    setupMocks.resolveLocalControlUiProbeLinks.mockImplementation(({ port }: { port: number }) => ({
      wsUrl: `ws://127.0.0.1:${port}`,
    }));
    setupMocks.waitForGatewayReachable.mockResolvedValue({ ok: true });
    const expectedInferenceRoute = await projectDefaultInferenceRoute(initialConfig);

    await applyCrestodianSetup({
      workspace: "/tmp/work",
      expectedInferenceRoute,
      surface: "cli",
      runtime: { log: () => {}, error: () => {}, exit: () => {} },
    });

    expect(setupMocks.configureGatewayForSetup).toHaveBeenCalledTimes(2);
    expect(setupMocks.configureGatewayForSetup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseConfig: concurrentConfig,
        localPort: 19000,
        quickstartGateway: expect.objectContaining({ port: 19000, bind: "lan" }),
      }),
    );
    expect(setupMocks.writeWizardConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ gateway: expect.objectContaining({ port: 19000, bind: "lan" }) }),
      expect.objectContaining({ baseHash: "hash-2", migrationBaseConfig: concurrentConfig }),
    );
    expect(setupMocks.ensureGatewayServiceForOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          gateway: expect.objectContaining({ port: 19000, bind: "lan" }),
        }),
        settings: expect.objectContaining({
          port: 19000,
          bind: "lan",
          gatewayToken: "concurrent-token",
        }),
      }),
    );
    expect(setupMocks.resolveLocalControlUiProbeLinks).toHaveBeenCalledWith(
      expect.objectContaining({ port: 19000, bind: "lan" }),
    );
    expect(setupMocks.waitForGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:19000", token: "concurrent-token" }),
    );
  });
});
