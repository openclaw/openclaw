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

vi.mock("./onboard-skills.js", () => ({ setupSkills: mocks.setupSkills }));

vi.mock("./onboard-channels.js", () => ({ setupChannels: mocks.setupChannels }));

import { runConfigureWizard } from "./configure.wizard.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

function setConfigSnapshot(config: OpenClawConfig) {
  mocks.state.snapshot = {
    exists: true,
    valid: true,
    hash: "config-hash",
    config,
    sourceConfig: config,
    issues: [],
  };
}

function expectWorkspaceSetup(workspaceDir: string, agentId: string) {
  expect(mocks.setupPluginConfig).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir }));
  expect(mocks.setupSkills).toHaveBeenCalledWith(
    expect.any(Object),
    workspaceDir,
    runtime,
    expect.any(Object),
  );
  expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
    workspaceDir,
    runtime,
    expect.objectContaining({ agentId }),
  );
}

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
    setConfigSnapshot(baseConfig);
    mocks.text.mockResolvedValue("/tmp/new-ops-workspace");
    mocks.select.mockResolvedValue("configure");
    mocks.setupPluginConfig.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => config,
    );
    mocks.setupSkills.mockImplementation(async (config: OpenClawConfig) => config);
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
    expectWorkspaceSetup("/tmp/new-ops-workspace", "ops");
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
    setConfigSnapshot(baseConfig);
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
    expectWorkspaceSetup("/tmp/new-main-workspace", "main");
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
    setConfigSnapshot(config);
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
    expectWorkspaceSetup("/tmp/new-beta-workspace", "beta");
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
    setConfigSnapshot(baseConfig);
    mocks.text.mockResolvedValue("/tmp/new-ops-workspace");

    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills"] },
      runtime,
    );

    expectWorkspaceSetup("/tmp/new-ops-workspace", "ops");
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
    setConfigSnapshot(baseConfig);
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
    expectWorkspaceSetup("/tmp/new-global-workspace", "ops");
  });

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
    setConfigSnapshot(config);
    mocks.select.mockResolvedValueOnce("remove");

    await runConfigureWizard({ command: "configure", sections: ["channels"] }, runtime);

    expect(mocks.setupChannels).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: config }),
    );
  });
});
