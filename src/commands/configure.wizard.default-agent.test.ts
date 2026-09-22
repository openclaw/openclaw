// Configure wizard tests keep workspace-owned effects on the configured default agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { committedConfigFiles as configFiles } from "./committed-config.test-support.js";

type SetupChannels = typeof import("./onboard-channels.js").setupChannels;

const mocks = vi.hoisted(() => ({
  state: { snapshot: undefined as unknown },
  commitConfig: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  setupPluginConfig: vi.fn(),
  setupSkills: vi.fn(),
  promptAuthConfig: vi.fn(),
  setupChannels: vi.fn<SetupChannels>(async (config) => config),
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  createConfigIO: () => ({
    readConfigFileSnapshotForWrite: async () => ({ snapshot: mocks.state.snapshot }),
  }),
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: mocks.state.snapshot,
    writeOptions: {
      expectedConfigPath: "/tmp/openclaw.json",
      ownedConfigPathForWrite: "/tmp/openclaw.json",
    },
  }),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));

vi.mock("../plugins/install-record-commit.js", () => ({
  commitConfigWithPendingPluginInstalls: mocks.commitConfig,
  transformConfigWithPendingPluginInstalls: async (params: {
    transform: (config: OpenClawConfig) => { nextConfig: OpenClawConfig };
    writeOptions?: Record<string, unknown>;
  }) => {
    const snapshot = mocks.state.snapshot as {
      sourceConfig?: OpenClawConfig;
      config: OpenClawConfig;
    };
    const nextConfig = params.transform(snapshot.sourceConfig ?? snapshot.config).nextConfig;
    const committed = await mocks.commitConfig({ nextConfig, writeOptions: params.writeOptions });
    return committed;
  },
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  }),
}));

vi.mock("../wizard/setup.plugin-config.js", () => ({
  configurePluginConfig: mocks.setupPluginConfig,
}));

vi.mock("./configure.shared.js", () => ({
  CONFIGURE_SECTION_OPTIONS: [],
  confirm: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  select: mocks.select,
  text: mocks.text,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  guardCancel: (value: unknown) => value,
  probeGatewayReachable: vi.fn(),
  resolveAdvertisedControlUiLinks: vi.fn(),
  resolveLocalControlUiProbeLinks: vi.fn(),
  summarizeExistingConfig: vi.fn(() => ""),
  waitForGatewayReachable: vi.fn(),
}));

vi.mock("./configure.gateway-auth.js", () => ({ promptAuthConfig: mocks.promptAuthConfig }));

vi.mock("./onboard-skills.js", () => ({ setupSkills: mocks.setupSkills }));

vi.mock("./onboard-channels.js", () => ({ setupChannels: mocks.setupChannels }));

import { runConfigureWizard } from "./configure.wizard.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

describe("runConfigureWizard default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configFiles.clear();
    mocks.select.mockReset();
    mocks.text.mockReset();
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
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "config-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
      issues: [],
    };
    mocks.text.mockResolvedValue("/tmp/new-ops-workspace");
    mocks.select.mockResolvedValue("configure");
    mocks.setupPluginConfig.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => config,
    );
    mocks.setupSkills.mockImplementation(async (config: OpenClawConfig) => config);
    mocks.promptAuthConfig.mockImplementation(async (config: OpenClawConfig) => config);
    mocks.commitConfig.mockImplementation(async ({ nextConfig }: { nextConfig: OpenClawConfig }) =>
      configFiles.write(nextConfig),
    );
  });

  it("uses the concrete default-agent workspace for provisioning, plugins, and skills", async () => {
    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills"] },
      runtime,
    );

    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ workspace: "/tmp/global-workspace" }),
            entries: expect.objectContaining({
              ops: expect.objectContaining({ workspace: "/tmp/new-ops-workspace" }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/new-ops-workspace" }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      "/tmp/new-ops-workspace",
      runtime,
      expect.any(Object),
    );
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/new-ops-workspace",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
  });

  it("uses the configured system agent when ownership is explicit", async () => {
    const baseConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          workspace: "/tmp/global-workspace",
          systemAgent: { agentId: "main" },
        },
        entries: {
          MAIN: {
            agentDir: "/tmp/main-agent",
          },
          ops: {
            agentDir: "/tmp/ops-agent",
            workspace: "/tmp/ops-workspace",
          },
        },
      },
    } satisfies OpenClawConfig;
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "config-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
      issues: [],
    };
    mocks.text.mockResolvedValue("/tmp/new-main-workspace");

    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills"] },
      runtime,
    );

    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ workspace: "/tmp/global-workspace" }),
            entries: {
              MAIN: {
                agentDir: "/tmp/main-agent",
                workspace: "/tmp/new-main-workspace",
              },
              ops: {
                agentDir: "/tmp/ops-agent",
                workspace: "/tmp/ops-workspace",
              },
            },
          }),
        }),
      }),
    );
    expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/new-main-workspace" }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      "/tmp/new-main-workspace",
      runtime,
      expect.any(Object),
    );
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/new-main-workspace",
      runtime,
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("selects one explicit owner for workspace, plugins, skills, and channel setup", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          alpha: { workspace: "/tmp/alpha-workspace" },
          beta: { workspace: "/tmp/beta-workspace" },
        },
      },
    };
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "config-hash",
      config,
      sourceConfig: config,
      issues: [],
    };
    mocks.select.mockResolvedValueOnce("beta").mockResolvedValueOnce("configure");
    mocks.text.mockResolvedValueOnce("/tmp/new-beta-workspace");

    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills", "channels"] },
      runtime,
    );

    const committed = mocks.commitConfig.mock.calls[0]?.[0].nextConfig as OpenClawConfig;
    expect(committed.agents).toEqual({
      ownership: "explicit",
      entries: {
        alpha: { workspace: "/tmp/alpha-workspace" },
        beta: { workspace: "/tmp/new-beta-workspace" },
      },
    });
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/new-beta-workspace",
      runtime,
      expect.objectContaining({ agentId: "beta" }),
    );
    expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/new-beta-workspace" }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      "/tmp/new-beta-workspace",
      runtime,
      expect.any(Object),
    );
    expect(mocks.setupChannels).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.any(Object),
      expect.objectContaining({ workspaceDir: "/tmp/new-beta-workspace" }),
    );
    expect(
      mocks.select.mock.calls.filter(
        ([params]) => params.message === "Which agent do you want to configure?",
      ),
    ).toHaveLength(1);
  });

  it("preselects a validated explicit owner for model and channel sections", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          alpha: { agentDir: "/tmp/alpha-agent", workspace: "/tmp/alpha-workspace" },
          ops: { agentDir: "/tmp/ops-agent", workspace: "/tmp/ops-workspace" },
        },
      },
    };
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "hash",
      config,
      sourceConfig: config,
      issues: [],
    };
    await runConfigureWizard(
      { command: "configure", agentId: " OPS ", sections: ["model", "channels"] },
      runtime,
    );
    expect(mocks.promptAuthConfig).toHaveBeenCalledWith(config, runtime, expect.any(Object), {
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      workspaceDir: "/tmp/ops-workspace",
      defaultsScope: "agent",
    });
    expect(mocks.setupChannels).toHaveBeenCalledWith(
      config,
      runtime,
      expect.any(Object),
      expect.objectContaining({ workspaceDir: "/tmp/ops-workspace" }),
    );
    expect(
      mocks.select.mock.calls.some(
        ([params]) => params.message === "Which agent do you want to configure?",
      ),
    ).toBe(false);
    expect(mocks.commitConfig).toHaveBeenCalledOnce();
  });

  it.each(["", "ops!", "ops".repeat(22), "unknown"])(
    "rejects selector %j before prompts, setup, or persistence",
    async (agentId) => {
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            ops: { workspace: "/tmp/ops-workspace" },
            alpha: { workspace: "/tmp/alpha-workspace" },
            ["ops".repeat(22).slice(0, 64)]: { workspace: "/tmp/truncated-workspace" },
          },
        },
      };
      mocks.state.snapshot = {
        exists: true,
        valid: true,
        hash: "hash",
        config,
        sourceConfig: config,
        issues: [],
      };
      await expect(runConfigureWizard({ command: "configure", agentId }, runtime)).rejects.toThrow(
        agentId === "unknown" ? "Unknown agent" : "Invalid --agent",
      );
      for (const effect of [
        mocks.select,
        mocks.text,
        mocks.promptAuthConfig,
        mocks.setupChannels,
        mocks.setupPluginConfig,
        mocks.setupSkills,
        mocks.ensureWorkspaceAndSessions,
        mocks.commitConfig,
      ]) {
        expect(effect).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves the legacy default owner when system-agent ownership is not explicit", async () => {
    const baseConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/global-workspace",
          systemAgent: { agentId: "main" },
        },
        entries: {
          MAIN: { agentDir: "/tmp/main-agent" },
          ops: {
            default: true,
            agentDir: "/tmp/ops-agent",
            workspace: "/tmp/ops-workspace",
          },
        },
      },
    } satisfies OpenClawConfig;
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "config-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
      issues: [],
    };
    mocks.text.mockResolvedValue("/tmp/new-ops-workspace");

    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills"] },
      runtime,
    );

    expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/new-ops-workspace" }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      "/tmp/new-ops-workspace",
      runtime,
      expect.any(Object),
    );
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/new-ops-workspace",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            entries: expect.objectContaining({
              MAIN: expect.not.objectContaining({ workspace: "/tmp/new-ops-workspace" }),
              ops: expect.objectContaining({ workspace: "/tmp/new-ops-workspace" }),
            }),
          }),
        }),
      }),
    );
  });

  it("keeps a workspace-less legacy owner on the global workspace", async () => {
    const baseConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/global-workspace",
          systemAgent: { agentId: "main" },
        },
        entries: {
          main: { agentDir: "/tmp/main-agent" },
          ops: {
            agentDir: "/tmp/ops-agent",
          },
        },
      },
    } satisfies OpenClawConfig;
    retainLegacyDefaultAgentId(baseConfig, "ops");
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "config-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
      issues: [],
    };
    mocks.text.mockResolvedValue("/tmp/new-global-workspace");

    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills"] },
      runtime,
    );

    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ workspace: "/tmp/new-global-workspace" }),
            entries: baseConfig.agents.entries,
          }),
        }),
      }),
    );
    expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/new-global-workspace" }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      "/tmp/new-global-workspace",
      runtime,
      expect.any(Object),
    );
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/new-global-workspace",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
  });

  it.each([false, true])(
    "keeps a selected legacy sibling workspace private (provisioning fails=%s)",
    async (provisioningFails) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: "/tmp/main-workspace" },
          entries: {
            main: { default: true, agentDir: "/tmp/main-agent" },
            ops: { agentDir: "/tmp/ops-agent" },
          },
        },
      };
      mocks.state.snapshot = {
        exists: true,
        valid: true,
        hash: "config-hash",
        config,
        sourceConfig: config,
        issues: [],
      };
      mocks.text.mockResolvedValueOnce("/tmp/selected-ops-workspace");
      if (provisioningFails) {
        mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(
          new Error("workspace is unwritable"),
        );
      }
      const result = runConfigureWizard(
        {
          command: "configure",
          agentId: "ops",
          sections: ["workspace", "model", "plugins", "skills", "channels"],
        },
        runtime,
      );
      if (provisioningFails) {
        await expect(result).rejects.toThrow("workspace is unwritable");
        expect(mocks.commitConfig).not.toHaveBeenCalled();
        expect(mocks.promptAuthConfig).not.toHaveBeenCalled();
        expect(mocks.setupPluginConfig).not.toHaveBeenCalled();
        expect(mocks.setupSkills).not.toHaveBeenCalled();
        expect(mocks.setupChannels).not.toHaveBeenCalled();
      } else {
        await result;
        expect(mocks.commitConfig).toHaveBeenCalledOnce();
        const committed = mocks.commitConfig.mock.calls[0]?.[0].nextConfig as OpenClawConfig;
        expect(committed.agents).toEqual({
          defaults: { workspace: "/tmp/main-workspace" },
          entries: {
            main: { default: true, agentDir: "/tmp/main-agent" },
            ops: { agentDir: "/tmp/ops-agent", workspace: "/tmp/selected-ops-workspace" },
          },
        });
        expect(mocks.promptAuthConfig).toHaveBeenCalledWith(
          expect.any(Object),
          runtime,
          expect.any(Object),
          {
            agentId: "ops",
            agentDir: "/tmp/ops-agent",
            workspaceDir: "/tmp/selected-ops-workspace",
            defaultsScope: "agent",
          },
        );
        expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceDir: "/tmp/selected-ops-workspace" }),
        );
        expect(mocks.setupSkills).toHaveBeenCalledWith(
          expect.any(Object),
          "/tmp/selected-ops-workspace",
          runtime,
          expect.any(Object),
        );
        expect(mocks.setupChannels).toHaveBeenCalledWith(
          expect.any(Object),
          runtime,
          expect.any(Object),
          expect.objectContaining({ workspaceDir: "/tmp/selected-ops-workspace" }),
        );
      }
      expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
        "/tmp/selected-ops-workspace",
        runtime,
        expect.objectContaining({ agentId: "ops" }),
      );
      expect(config.agents?.defaults?.workspace).toBe("/tmp/main-workspace");
      expect(config.agents?.entries?.ops?.workspace).toBeUndefined();
    },
  );

  it("does not persist an unprovisionable workspace", async () => {
    mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));

    await expect(
      runConfigureWizard(
        { command: "configure", sections: ["workspace", "plugins", "skills"] },
        runtime,
      ),
    ).rejects.toThrow("workspace is unwritable");

    expect(mocks.setupPluginConfig).not.toHaveBeenCalled();
    expect(mocks.setupSkills).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
  });

  it("runs channel post-write hooks after the converged config write", async () => {
    const hook = vi.fn(async () => {});
    mocks.setupChannels.mockImplementationOnce(async (config, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.({
        channel: "matrix",
        accountId: "ops",
        run: hook,
      });
      return config;
    });

    await runConfigureWizard({ command: "configure", sections: ["channels"] }, runtime);

    expect(hook).toHaveBeenCalledOnce();
    expect(mocks.commitConfig.mock.invocationCallOrder[0]!).toBeLessThan(
      hook.mock.invocationCallOrder[0]!,
    );
  });

  it("can remove channel configuration without selecting an agent", async () => {
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    };
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "config-hash",
      config,
      sourceConfig: config,
      issues: [],
    };
    mocks.select.mockResolvedValueOnce("remove");

    await runConfigureWizard({ command: "configure", sections: ["channels"] }, runtime);

    expect(mocks.setupChannels).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: config }),
    );
  });
});
