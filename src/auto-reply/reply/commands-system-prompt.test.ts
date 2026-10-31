import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingToolsAsync } from "../../agents/agent-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import type { resolveRuntimeChannelPromptContext } from "../../agents/runtime-capabilities.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const { createOpenClawCodingToolsAsyncMock, logWarnMock, makeBootstrapWarnMock } = vi.hoisted(
  () => ({
    createOpenClawCodingToolsAsyncMock: vi.fn(() => []),
    logWarnMock: vi.fn(),
    makeBootstrapWarnMock: vi.fn((params: { warn?: (message: string) => void }) => params.warn),
  }),
);

// mock-isolation: Fix channel prompt facts without loading live channel plugin state.
vi.mock("../../agents/runtime-capabilities.js", () => ({
  resolveRuntimeChannelPromptContext: vi.fn<typeof resolveRuntimeChannelPromptContext>(() => ({
    runtimeChannel: "telegram",
    runtimeCapabilities: ["voice"],
    reactionGuidance: { level: "minimal", channel: "Telegram" },
    messageToolHints: ["Use the message tool."],
  })),
}));

// mock-isolation: Keep shell discovery independent of the host running the prompt fixture.
vi.mock("../../agents/shell-utils.js", () => ({ detectRuntimeShell: vi.fn(() => "zsh") }));

// mock-isolation: Use a fixed machine label without reading host identity.
vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-host"),
}));

// mock-isolation: Use a fixed OS label without reading the host platform.
vi.mock("../../infra/os-summary.js", () => ({ resolveRuntimeOsLabel: vi.fn(() => "TestOS 1.0") }));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const createLogger = (subsystem: string): SubsystemLogger => ({
    subsystem,
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: (name) => createLogger(`${subsystem}/${name}`),
  });
  return {
    ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
    createSubsystemLogger: vi.fn(createLogger),
  };
});

// mock-isolation: Exercise prompt composition without reading workspace bootstrap files.
vi.mock("../../agents/bootstrap-files.js", () => ({
  makeBootstrapWarn: makeBootstrapWarnMock,
  resolveBootstrapContextForRun: vi.fn(async () => ({ bootstrapFiles: [], contextFiles: [] })),
}));

// mock-isolation: Keep real runtime classification while preventing sandbox workspace startup.
vi.mock("../../agents/sandbox/context.js", () => ({
  ensureSandboxWorkspaceForSession: vi.fn(async () => null),
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => false),
}));

vi.mock("../../skills/runtime/session-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/runtime/session-snapshot.js")>()),
  resolveReusableWorkspaceSkillSnapshot: vi.fn(() => ({
    snapshot: { prompt: "", skills: [], resolvedSkills: [] },
    shouldRefresh: false,
  })),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5" })),
}));

// mock-isolation: Keep host discovery outside command prompt fixtures.
vi.mock("../../agents/system-prompt-params.js", () => ({
  buildSystemPromptParams: vi.fn(() => ({
    runtimeInfo: { host: "unknown", os: "unknown", arch: "unknown", node: process.version },
  })),
}));

vi.mock("../../agents/system-prompt.js", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
}));

// mock-isolation: Inspect prompt composition with fixture tools without initializing tool integrations.
vi.mock("../../agents/agent-tools.js", () => ({
  createOpenClawCodingToolsAsync: createOpenClawCodingToolsAsyncMock,
}));

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

function makeParams(overrides: Partial<HandleCommandsParams> = {}): HandleCommandsParams {
  return {
    ctx: {
      SessionKey: "agent:main:default",
      SenderName: "Alice",
      SenderUsername: "alice_u",
      SenderE164: "+15551234567",
    },
    cfg: {},
    command: { channel: "telegram", senderId: "sender-1" },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    agentId: "main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      groupId: "group-1",
      groupChannel: "#general",
      space: "guild-1",
      spawnedBy: "agent:parent",
    },
    sessionKey: "agent:main:default",
    workspaceDir: "/tmp/workspace",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    provider: "openai",
    model: "gpt-5.4",
    ...overrides,
  } as unknown as HandleCommandsParams;
}

function firstArg(fn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const arg = fn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error("Expected a mock call");
  }
  return arg;
}

function sessionMetadata(prefix: string, spawnedBy = `agent:${prefix}`) {
  return {
    sessionId: `${prefix}-session`,
    updatedAt: Date.now(),
    groupId: `${prefix}-group`,
    groupChannel: `#${prefix}`,
    space: `${prefix}-space`,
    spawnedBy,
  };
}

describe("resolveCommandsSystemPromptBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOpenClawCodingToolsAsyncMock.mockReturnValue([]);
    vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue(null);
    vi.mocked(resolveReusableWorkspaceSkillSnapshot).mockReturnValue({
      snapshot: { prompt: "", skills: [], resolvedSkills: [] },
      shouldRefresh: false,
    } as never);
  });

  it.each([
    { sessionKey: "global", policySessionKey: undefined, policyAgentId: "target" },
    { sessionKey: "global", policySessionKey: "agent:main:group", policyAgentId: "main" },
  ])(
    "uses the sandbox policy owner $policyAgentId for $sessionKey / $policySessionKey",
    async ({ sessionKey, policySessionKey, policyAgentId }) => {
      const params = makeParams();
      params.ctx.SessionKey = "agent:main:telegram:slash-session";
      params.ctx.RuntimePolicySessionKey = policySessionKey;
      params.sessionKey = sessionKey;
      params.agentId = "target";
      params.cfg = { agents: { ownership: "explicit", entries: { main: {}, target: {} } } };

      const result = await resolveCommandsSystemPromptBundle(params);

      expect(result.sandboxRuntime).toMatchObject({
        agentId: "target",
        sessionKey,
        classificationAgentId: policyAgentId,
        classificationSessionKey: policySessionKey ?? sessionKey,
      });
    },
  );

  it("rejects an independent global sandbox policy without its own owner", async () => {
    const params = makeParams({
      agentId: "target",
      sessionKey: "agent:target:main",
      cfg: { agents: { ownership: "explicit", entries: { main: {}, target: {} } } },
    });
    params.ctx.RuntimePolicySessionKey = "global";

    await expect(resolveCommandsSystemPromptBundle(params)).rejects.toMatchObject({
      code: "AGENT_SELECTION_REQUIRED",
    });
    expect(vi.mocked(ensureSandboxWorkspaceForSession)).not.toHaveBeenCalled();
  });

  it("records bootstrap exclusions for generated command prompts", async () => {
    await resolveCommandsSystemPromptBundle(makeParams());

    expect(vi.mocked(makeBootstrapWarn)).toHaveBeenCalledWith({
      sessionLabel: "agent:main:default",
      workspaceDir: "/tmp/workspace",
      warn: expect.any(Function),
    });
    const bootstrapParams = firstArg(vi.mocked(resolveBootstrapContextForRun));
    const warn = bootstrapParams.warn as ((message: string) => void) | undefined;
    expect(warn).toEqual(expect.any(Function));
    warn?.("excluding automatic memory context");
    expect(logWarnMock).toHaveBeenCalledWith("excluding automatic memory context");
  });

  it("prefers the target session entry for bootstrap and tool metadata", async () => {
    const params = makeParams();
    params.sessionEntry = sessionMetadata("wrapper");
    params.sessionStore = {
      "agent:target:telegram:direct:target-session": sessionMetadata(
        "target",
        "agent:target-parent",
      ),
    } as HandleCommandsParams["sessionStore"];
    params.sessionKey = "agent:target:telegram:direct:target-session";
    params.agentId = "target";

    await resolveCommandsSystemPromptBundle(params);

    expect(firstArg(vi.mocked(resolveBootstrapContextForRun))).toMatchObject({
      sessionId: "target-session",
      agentId: "target",
    });
    expect(firstArg(vi.mocked(buildSystemPromptParams))).toMatchObject({
      runtime: {
        sessionKey: "agent:target:telegram:direct:target-session",
        sessionId: "target-session",
      },
    });
    expect(firstArg(vi.mocked(createOpenClawCodingToolsAsync))).toMatchObject({
      agentId: "target",
      sessionKey: "agent:target:telegram:direct:target-session",
      groupId: "target-group",
      groupChannel: "#target",
      groupSpace: "target-space",
      spawnedBy: "agent:target-parent",
    });
  });

  it("uses the resolved session key and forwards full-access block reasons", async () => {
    const params = makeParams({
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } },
      sessionKey: "agent:target:default",
      agentId: "target",
      elevated: { enabled: true, allowed: false, failures: [] },
    });
    params.ctx.SessionKey = "agent:source:default";

    const result = await resolveCommandsSystemPromptBundle(params);

    expect(result.sandboxRuntime.sessionKey).toBe("agent:target:default");

    expect(firstArg(vi.mocked(buildAgentSystemPrompt))).toMatchObject({
      sandboxInfo: {
        enabled: true,
        elevated: { fullAccessAvailable: false, fullAccessBlockedReason: "host-policy" },
      },
    });
  });

  it("inspects the configured agent and canonical nested execution workspace", async () => {
    const params = makeParams();
    params.cfg = { agents: { defaults: { workspace: "/tmp/agent-workspace" } } };
    params.workspaceDir = "/tmp/task-checkout/packages/app";
    params.sessionEntry!.worktree = {
      id: "task",
      branch: "task",
      repoRoot: "/tmp/project",
      canonicalWorkspaceDir: "/tmp/project/packages/app",
    };
    await resolveCommandsSystemPromptBundle(params);
    expect(resolveReusableWorkspaceSkillSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/agent-workspace",
        executionWorkspaceDir: "/tmp/project/packages/app",
      }),
    );
  });

  it("uses materialized sandbox library skill paths", async () => {
    const root = "/tmp/openclaw-command-sandbox-skills";
    const workspaceDir = path.join(root, "workspace");
    const skillsWorkspaceDir = path.join(root, "state", "sandbox-skills");
    const skillDir = path.join(skillsWorkspaceDir, "skills", "gog");
    const hostSkillPath = "/host/skills/gog/SKILL.md";
    const hostSnapshot: SkillSnapshot = {
      prompt: "<available_skills>Host skill catalog</available_skills>",
      skills: [{ name: "gog" }],
      resolvedSkills: [
        {
          name: "gog",
          description: "Gog skill",
          filePath: hostSkillPath,
          baseDir: path.dirname(hostSkillPath),
          source: "openclaw-library",
          sourceInfo: createSyntheticSourceInfo(hostSkillPath, { source: "openclaw-library" }),
          disableModelInvocation: false,
        },
      ],
      librarySelections: [
        { skillId: "test-pin", revision: "revision-1", name: "gog", ownerProfileId: null },
      ],
    };
    const params = makeParams();
    params.workspaceDir = workspaceDir;
    params.sessionKey = "global";
    params.agentId = "target";
    params.cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          target: { workspace: path.join(root, "agent-workspace"), sandbox: { mode: "all" } },
        },
      },
    };
    vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue({
      workspaceDir,
      containerWorkdir: "/workspace",
      skillsWorkspaceDir,
      skillUsagePaths: [
        {
          skillName: "gog",
          skillFile: hostSkillPath,
          readPath: path.join(skillDir, "SKILL.md"),
          skillSource: "unknown",
        },
      ],
      skillsEligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: () => true,
          hasAnyBin: () => true,
          note: "sandbox",
        },
      },
      workspaceAccess: "rw",
    } as never);
    vi.mocked(resolveReusableWorkspaceSkillSnapshot).mockReturnValue({
      snapshot: hostSnapshot,
      shouldRefresh: false,
    } as never);

    const result = await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(ensureSandboxWorkspaceForSession)).toHaveBeenCalledWith({
      skillsSnapshot: hostSnapshot,
      config: params.cfg,
      sessionKey: "global",
      agentId: "target",
      workspaceDir,
    });
    const sandboxSkillPath = "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md";
    expect(result.skillsPrompt).toContain(sandboxSkillPath);
    expect(result.skillsPrompt).not.toContain(hostSkillPath);
    expect(vi.mocked(resolveReusableWorkspaceSkillSnapshot)).toHaveBeenCalledOnce();
    const promptParams = firstArg(vi.mocked(buildAgentSystemPrompt));
    expect(promptParams.skillsPrompt).toBe(result.skillsPrompt);
  });

  it("uses config-backed prompt settings for the target agent", async () => {
    createOpenClawCodingToolsAsyncMock.mockReturnValue([{ name: "sessions_spawn" }] as never);
    const params = makeParams();
    params.cfg = { agents: { defaults: { subagents: { delegationMode: "prefer" } } } };

    await resolveCommandsSystemPromptBundle(params);

    expect(firstArg(vi.mocked(buildAgentSystemPrompt))).toMatchObject({
      subagentDelegationMode: "prefer",
      toolNames: ["sessions_spawn"],
    });
  });
});
