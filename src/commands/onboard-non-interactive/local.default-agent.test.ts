// Non-interactive setup tests keep provisioning and output on the configured default agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  applyGatewayConfig: vi.fn(),
  commitConfig: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  inferAuthChoice: vi.fn(),
  logConfigUpdated: vi.fn(),
  logJson: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  resolveGatewayPort: () => 18789,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  resolveLocalControlUiProbeLinks: vi.fn(),
  waitForGatewayReachable: vi.fn(),
}));

vi.mock("./config-write.js", () => ({
  commitNonInteractiveOnboardConfig: mocks.commitConfig,
}));

vi.mock("../onboard-agent.js", () => ({
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("./local/auth-choice.js", () => ({
  applyNonInteractiveAuthChoice: mocks.applyAuthChoice,
}));

vi.mock("./local/auth-choice-inference.js", () => ({
  inferAuthChoiceFromFlags: mocks.inferAuthChoice,
}));

vi.mock("./local/gateway-config.js", () => ({
  applyNonInteractiveGatewayConfig: mocks.applyGatewayConfig,
}));

vi.mock("./local/output.js", () => ({
  logNonInteractiveOnboardingFailure: vi.fn(),
  logNonInteractiveOnboardingJson: mocks.logJson,
}));

vi.mock("./local/skills-config.js", () => ({
  applyNonInteractiveSkillsConfig: ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
}));

import { runNonInteractiveLocalSetup } from "./local.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

describe("runNonInteractiveLocalSetup default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyAuthChoice.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
    );
    mocks.applyGatewayConfig.mockImplementation(
      ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
        nextConfig,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
      }),
    );
    mocks.commitConfig.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
    );
    mocks.ensureOnboardingAgent.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({
        config,
        agentId: "ops",
        bootstrapPending: false,
      }),
    );
    mocks.inferAuthChoice.mockReturnValue({ matches: [] });
  });

  it("rejects ambiguous provider flags before creating an agent or writing setup state", async () => {
    mocks.inferAuthChoice.mockReturnValue({
      matches: [
        { optionKey: "openaiApiKey", authChoice: "openai-api-key", label: "--openai-api-key" },
        {
          optionKey: "anthropicApiKey",
          authChoice: "anthropic-api-key",
          label: "--anthropic-api-key",
        },
      ],
    });

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        openaiApiKey: "openai-test-key",
        anthropicApiKey: "anthropic-test-key",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Multiple API key flags were provided"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.applyGatewayConfig).not.toHaveBeenCalled();
    expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
    expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
  });

  it("resolves provider auth in the requested first-agent workspace before creating state", async () => {
    const workspace = "/tmp/requested-provider-workspace";
    mocks.ensureOnboardingAgent.mockImplementationOnce(
      async ({ config }: { config: OpenClawConfig }) => ({
        config: {
          ...config,
          agents: {
            ...config.agents,
            entries: { main: { default: true, workspace } },
          },
        },
        agentId: "main",
        bootstrapPending: true,
      }),
    );

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        workspace,
        authChoice: "demo-api-key",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({ defaults: expect.objectContaining({ workspace }) }),
        }),
        target: expect.objectContaining({ agentId: "main", workspaceDir: workspace }),
      }),
    );
    expect(mocks.applyAuthChoice.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!,
    );
    expect(mocks.commitConfig.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects invalid gateway options before provider auth or first-agent creation", async () => {
    mocks.applyGatewayConfig.mockReturnValue(null);

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        authChoice: "demo-api-key",
        gatewayPort: 70_000,
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(mocks.applyGatewayConfig).toHaveBeenCalledOnce();
    expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
    expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
  });

  it("targets the selected keyed agent when --workspace matches the inherited default", async () => {
    const baseConfig = {
      agents: {
        defaults: { workspace: "/tmp/global-workspace" },
        entries: {
          ops: {
            default: true,
            agentDir: "/tmp/ops-agent",
            workspace: "/tmp/ops-workspace",
          },
        },
      },
    } satisfies OpenClawConfig;

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        workspace: "/tmp/global-workspace",
        authChoice: "skip",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        json: true,
      },
      runtime,
      baseConfig,
    });

    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ workspace: "/tmp/global-workspace" }),
            entries: expect.objectContaining({
              ops: expect.objectContaining({ workspace: "/tmp/global-workspace" }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/global-workspace",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(mocks.logJson).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/global-workspace" }),
    );
  });

  it("authenticates a selected agent in its requested workspace", async () => {
    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        agent: "ops",
        workspace: "/tmp/new-ops-workspace",
        authChoice: "demo-api-key",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
      },
      runtime,
      baseConfig: {
        agents: {
          ownership: "explicit",
          entries: {
            ops: { workspace: "/tmp/old-ops-workspace" },
            research: {},
          },
        },
      },
    });

    expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            entries: expect.objectContaining({
              ops: expect.objectContaining({ workspace: "/tmp/new-ops-workspace" }),
            }),
          }),
        }),
        target: expect.objectContaining({
          agentId: "ops",
          workspaceDir: "/tmp/new-ops-workspace",
        }),
      }),
    );
  });

  it("authenticates a newly selected first agent in its requested workspace", async () => {
    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        agent: "ops",
        workspace: "/tmp/new-ops-workspace",
        authChoice: "demo-api-key",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
      },
      runtime,
      baseConfig: {},
    });

    expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            entries: expect.objectContaining({
              ops: expect.objectContaining({ workspace: "/tmp/new-ops-workspace" }),
            }),
          }),
        }),
        target: expect.objectContaining({
          agentId: "ops",
          workspaceDir: "/tmp/new-ops-workspace",
        }),
      }),
    );
  });

  it("keeps a sole agent workspace when an unselected rerun reports a conflict", async () => {
    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        workspace: "/tmp/requested-workspace",
        authChoice: "demo-api-key",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
      },
      runtime,
      baseConfig: {
        agents: {
          defaults: { workspace: "/tmp/current-workspace" },
          entries: { ops: { workspace: "/tmp/current-workspace" } },
        },
      },
    });

    expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ workspaceDir: "/tmp/current-workspace" }),
      }),
    );
    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            entries: expect.objectContaining({
              ops: expect.objectContaining({ workspace: "/tmp/current-workspace" }),
            }),
          }),
        }),
      }),
    );
  });

  it("rejects changing an include-owned selected agent workspace", async () => {
    await expect(
      runNonInteractiveLocalSetup({
        opts: {
          nonInteractive: true,
          mode: "local",
          agent: "ops",
          workspace: "/tmp/new-ops-workspace",
          authChoice: "demo-api-key",
          skipHooks: true,
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
        },
        runtime,
        agentRosterIncludeOwned: true,
        baseConfig: {
          agents: {
            ownership: "explicit",
            entries: {
              ops: { workspace: "/tmp/ops-workspace" },
              research: {},
            },
          },
        },
      }),
    ).rejects.toThrow(
      "Cannot set agents.entries.ops.workspace because the agent roster is $include-owned",
    );
    expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
  });

  it("keeps an include-owned sole workspace when an unselected override differs", async () => {
    await expect(
      runNonInteractiveLocalSetup({
        opts: {
          nonInteractive: true,
          mode: "local",
          workspace: "/tmp/requested-workspace",
          authChoice: "demo-api-key",
          skipHooks: true,
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
        },
        runtime,
        agentRosterIncludeOwned: true,
        baseConfig: {
          agents: { entries: { ops: { workspace: "/tmp/current-workspace" } } },
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          agentId: "ops",
          workspaceDir: "/tmp/current-workspace",
        }),
      }),
    );
    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            entries: { ops: expect.objectContaining({ workspace: "/tmp/current-workspace" }) },
          }),
        }),
      }),
    );
  });
});
