import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { defaultRuntime } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../agents/agent-create.js", () => ({ createAgent: mocks.createAgent }));
vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: mocks.readConfigFileSnapshot }));

const { ensureOnboardingAgent } = await import("./onboard-agent.js");

describe("onboarding main-agent creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgent.mockResolvedValue({
      status: "existing",
      agentId: "main",
      name: "main",
      workspace: "/tmp/work",
      agentDir: "/tmp/agent",
      bootstrapPending: true,
    });
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: false,
        valid: true,
        sourceConfig: { agents: { entries: { main: {} } }, gateway: {} },
        config: { agents: { entries: { main: {} } }, gateway: {} },
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        hash: "hash-after-create",
        sourceConfig: {
          agents: { entries: { main: {} } },
          gateway: { controlUi: { enabled: true } },
        },
        config: {
          agents: { entries: { main: {} } },
          gateway: { controlUi: { enabled: true } },
        },
      });
  });

  it("provisions explicit main through createAgent on a fresh install", async () => {
    const result = await ensureOnboardingAgent({
      config: {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        gateway: { mode: "local" },
      },
      workspace: "/tmp/work",
    });

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "main" }),
      }),
    );
    expect(result).toMatchObject({
      agentId: "main",
      config: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          entries: { main: {} },
        },
        gateway: { mode: "local", controlUi: { enabled: true } },
      },
    });
  });

  it("provisions the explicitly requested first agent on a fresh install", async () => {
    mocks.createAgent.mockResolvedValueOnce({
      status: "created",
      agentId: "ops",
      name: "ops",
      workspace: "/tmp/ops-work",
      agentDir: "/tmp/ops-agent",
      bootstrapPending: true,
    });
    mocks.readConfigFileSnapshot
      .mockReset()
      .mockResolvedValueOnce({
        exists: false,
        valid: true,
        sourceConfig: {},
        config: {},
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        sourceConfig: { agents: { entries: { ops: {} } } },
        config: { agents: { entries: { ops: {} } } },
      });

    const result = await ensureOnboardingAgent({
      config: {},
      workspace: "/tmp/ops-work",
      agentId: "ops",
    });

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "ops", name: "ops" }),
      }),
    );
    expect(mocks.createAgent.mock.calls[0]?.[0]).not.toHaveProperty("bootstrapMain");
    expect(result.agentId).toBe("ops");
  });

  it("provisions a first-agent roster entry staged for auth discovery", async () => {
    mocks.createAgent.mockResolvedValueOnce({
      status: "created",
      agentId: "ops",
      name: "ops",
      workspace: "/tmp/ops-work",
      agentDir: "/tmp/ops-agent",
      bootstrapPending: true,
    });
    mocks.readConfigFileSnapshot
      .mockReset()
      .mockResolvedValueOnce({ exists: false, valid: true, sourceConfig: {}, config: {} })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        sourceConfig: { agents: { entries: { ops: {} } } },
        config: { agents: { entries: { ops: {} } } },
      });

    const result = await ensureOnboardingAgent({
      config: { agents: { entries: { ops: { workspace: "/tmp/ops-work" } } } },
      baseConfig: {},
      workspace: "/tmp/ops-work",
      agentId: "ops",
      candidateRosterIsStagedFirstAgent: true,
    });

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "ops", workspace: "/tmp/ops-work" }),
      }),
    );
    expect(result.agentId).toBe("ops");
  });

  it("preserves an explicit imported candidate roster", async () => {
    const config = { agents: { list: [{ id: "main", default: true }] } };

    const result = await ensureOnboardingAgent({
      config,
      workspace: "/tmp/work",
      preserveCandidateRoster: true,
    });

    expect(result).toEqual({
      config: { agents: { entries: { main: {} } } },
      agentId: "main",
      bootstrapPending: false,
    });
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
  it("reports the post-create config hash so callers can rebase their commit", async () => {
    // Regression (#112678): creating the first roster agent writes the config
    // file, so a caller holding a pre-create hash would fail its own optimistic
    // write with ConfigMutationConflictError and leave onboarding half-applied.
    const result = await ensureOnboardingAgent({
      config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      workspace: "/tmp/work",
    });

    expect(result.configHash).toBe("hash-after-create");
  });

  it("omits the config hash when no agent had to be created", async () => {
    const config = { agents: { list: [{ id: "main", default: true }] } };

    const result = await ensureOnboardingAgent({
      config,
      workspace: "/tmp/work",
      preserveCandidateRoster: true,
    });

    expect(result.configHash).toBeUndefined();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("accepts an explicit agent for a preserved multi-agent roster", async () => {
    const result = await ensureOnboardingAgent({
      config: { agents: { entries: { ops: {}, research: {} } } },
      workspace: "/tmp/work",
      preserveCandidateRoster: true,
      agentId: "research",
      runtime: defaultRuntime,
      selectionDeps: { interactive: false },
    });

    expect(result.agentId).toBe("research");
    expect(result.config.agents?.ownership).toBe("explicit");
  });

  it("materializes a preserved legacy list before stamping explicit ownership", async () => {
    const result = await ensureOnboardingAgent({
      config: {
        agents: { list: [{ id: "ops" }, { id: "research" }] },
        channels: { telegram: { enabled: true } },
        session: { store: "/tmp/shared-sessions.json" },
      },
      workspace: "/tmp/work",
      preserveCandidateRoster: true,
      agentId: "ops",
    });

    expect(result.config).toMatchObject({
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
          authInheritance: { agentId: "ops" },
          sessionStore: { agentId: "ops" },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "*" } }],
      talk: { agentId: "ops" },
    });
    expect(tryGetLegacyDefaultAgentId(result.config)).toBe("ops");
  });

  it("prompts for a preserved multi-agent roster in interactive mode", async () => {
    const selectAgent = vi.fn(async () => "research");
    const result = await ensureOnboardingAgent({
      config: {
        agents: {
          entries: { ops: { name: "Operations" }, research: { name: "Research" } },
        },
      },
      workspace: "/tmp/work",
      preserveCandidateRoster: true,
      runtime: defaultRuntime,
      selectionDeps: { interactive: true, selectAgent },
    });

    expect(result.agentId).toBe("research");
    expect(selectAgent).toHaveBeenCalledWith({
      message: "Select an agent for onboarding",
      options: [
        { value: "ops", label: "Operations (ops)" },
        { value: "research", label: "Research (research)" },
      ],
    });
  });

  it("fails non-interactive multi-agent onboarding with an actionable typed error", async () => {
    await expect(
      ensureOnboardingAgent({
        config: { agents: { entries: { ops: {}, research: {} } } },
        workspace: "/tmp/work",
        preserveCandidateRoster: true,
        runtime: defaultRuntime,
        selectionDeps: { interactive: false },
      }),
    ).rejects.toMatchObject({
      name: "AgentSelectionRequiredError",
      code: "AGENT_SELECTION_REQUIRED",
      surface: "onboarding",
      hint: expect.stringContaining("--agent <id>"),
    });
  });
});
