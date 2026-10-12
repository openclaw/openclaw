// Tests system prompt command output and bundled prompt section selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingToolsAsync } from "../../agents/agent-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { resolveRuntimeChannelPromptContext } from "../../agents/runtime-capabilities.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const {
  resolveRuntimeChannelPromptContextMock,
  createOpenClawCodingToolsAsyncMock,
  detectRuntimeShellMock,
  getMachineDisplayNameMock,
  logWarnMock,
  makeBootstrapWarnMock,
  resolveRuntimeOsLabelMock,
} = vi.hoisted(() => ({
  resolveRuntimeChannelPromptContextMock: vi.fn<typeof resolveRuntimeChannelPromptContext>(() => ({
    runtimeChannel: "telegram",
    runtimeCapabilities: ["voice"],
    reactionGuidance: { level: "minimal", channel: "Telegram" },
    messageToolHints: ["Use the message tool."],
  })),
  createOpenClawCodingToolsAsyncMock: vi.fn(() => []),
  detectRuntimeShellMock: vi.fn(() => "zsh"),
  getMachineDisplayNameMock: vi.fn(async () => "test-host"),
  logWarnMock: vi.fn(),
  makeBootstrapWarnMock: vi.fn((params: { warn?: (message: string) => void }) => params.warn),
  resolveRuntimeOsLabelMock: vi.fn(() => "TestOS 1.0"),
}));

// mock-isolation: Fix channel prompt facts without loading live channel plugin state.
vi.mock("../../agents/runtime-capabilities.js", () => ({
  resolveRuntimeChannelPromptContext: resolveRuntimeChannelPromptContextMock,
}));

vi.mock("../../agents/shell-utils.js", () => ({
  detectRuntimeShell: detectRuntimeShellMock,
}));

vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: getMachineDisplayNameMock,
}));

vi.mock("../../infra/os-summary.js", () => ({
  resolveRuntimeOsLabel: resolveRuntimeOsLabelMock,
}));

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

vi.mock("../../agents/bootstrap-files.js", () => ({
  makeBootstrapWarn: makeBootstrapWarnMock,
  resolveBootstrapContextForRun: vi.fn(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  })),
}));

vi.mock("../../agents/sandbox.js", async () => {
  const { resolveSandboxRuntimeStatus } = await vi.importActual<
    typeof import("../../agents/sandbox/runtime-status.js")
  >("../../agents/sandbox/runtime-status.js");
  return {
    ensureSandboxWorkspaceForSession: vi.fn(async () => null),
    resolveSandboxRuntimeStatus,
  };
});

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => false),
}));

vi.mock("../../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: vi.fn(() => ({
    snapshot: { prompt: "", skills: [], resolvedSkills: [] },
    shouldRefresh: false,
    snapshotVersion: "test-snapshot",
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

function makeParams(): HandleCommandsParams {
  return {
    ctx: {
      SessionKey: "agent:main:default",
      SenderId: "sender-1",
      SenderName: "Alice",
      SenderUsername: "alice_u",
      SenderE164: "+15551234567",
    },
    cfg: {},
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderId: "sender-1",
      senderIsOwner: true,
      isAuthorizedSender: true,
      rawBodyNormalized: "/context",
      commandBodyNormalized: "/context",
    },
    directives: {},
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
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
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

function requireFirstArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const arg = mockFn.mock.calls.at(0)?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} to be called`);
  }
  return arg;
}

describe("resolveCommandsSystemPromptBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOpenClawCodingToolsAsyncMock.mockClear();
    createOpenClawCodingToolsAsyncMock.mockReturnValue([]);
    vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue(null);
    vi.mocked(resolveReusableWorkspaceSkillSnapshot).mockReturnValue({
      snapshot: { prompt: "", skills: [], resolvedSkills: [] },
      shouldRefresh: false,
      snapshotVersion: "test-snapshot",
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
    const params = makeParams();
    params.agentId = "target";
    params.sessionKey = "agent:target:main";
    params.ctx.RuntimePolicySessionKey = "global";
    params.cfg = { agents: { ownership: "explicit", entries: { main: {}, target: {} } } };

    await expect(resolveCommandsSystemPromptBundle(params)).rejects.toMatchObject({
      code: "AGENT_SELECTION_REQUIRED",
    });
    expect(vi.mocked(ensureSandboxWorkspaceForSession)).not.toHaveBeenCalled();
  });

  it("records bootstrap exclusions for generated command prompts", async () => {
    const params = makeParams();

    await resolveCommandsSystemPromptBundle(params);

    expect(vi.mocked(makeBootstrapWarn)).toHaveBeenCalledWith({
      sessionLabel: "agent:main:default",
      workspaceDir: "/tmp/workspace",
      warn: expect.any(Function),
    });
    const bootstrapParams = requireFirstArg(
      vi.mocked(resolveBootstrapContextForRun),
      "resolveBootstrapContextForRun",
    );
    const warn = bootstrapParams.warn as ((message: string) => void) | undefined;
    expect(warn).toEqual(expect.any(Function));
    warn?.("excluding automatic memory context");
    expect(logWarnMock).toHaveBeenCalledWith("excluding automatic memory context");
  });

  it("prefers the target session entry for bootstrap and tool metadata", async () => {
    const params = makeParams();
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      groupId: "wrapper-group",
      groupChannel: "#wrapper",
      space: "wrapper-space",
      spawnedBy: "agent:wrapper",
    };
    params.sessionStore = {
      "agent:target:telegram:direct:target-session": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        groupId: "target-group",
        groupChannel: "#target",
        space: "target-space",
        spawnedBy: "agent:target-parent",
      },
    } as HandleCommandsParams["sessionStore"];
    params.sessionKey = "agent:target:telegram:direct:target-session";
    params.agentId = "target";

    await resolveCommandsSystemPromptBundle(params);

    const bootstrapParams = requireFirstArg(
      vi.mocked(resolveBootstrapContextForRun),
      "resolveBootstrapContextForRun",
    );
    expect(bootstrapParams.sessionId).toBe("target-session");
    expect(bootstrapParams.agentId).toBe("target");
    const runtimeParams = requireFirstArg(
      vi.mocked(buildSystemPromptParams),
      "buildSystemPromptParams",
    );
    expect(runtimeParams.runtime).toEqual(
      expect.objectContaining({
        sessionKey: "agent:target:telegram:direct:target-session",
        sessionId: "target-session",
      }),
    );
    const toolParams = requireFirstArg(
      vi.mocked(createOpenClawCodingToolsAsync),
      "createOpenClawCodingToolsAsync",
    );
    expect(toolParams.agentId).toBe("target");
    expect(toolParams.sessionKey).toBe("agent:target:telegram:direct:target-session");
    expect(toolParams.groupId).toBe("target-group");
    expect(toolParams.groupChannel).toBe("#target");
    expect(toolParams.groupSpace).toBe("target-space");
    expect(toolParams.spawnedBy).toBe("agent:target-parent");
  });

  it("uses the resolved session key and forwards full-access block reasons", async () => {
    const params = makeParams();
    params.cfg = { agents: { defaults: { sandbox: { mode: "all" } } } };
    params.sessionKey = "agent:target:default";
    params.agentId = "target";
    params.ctx.SessionKey = "agent:source:default";
    params.elevated = {
      enabled: true,
      allowed: false,
      failures: [],
    };

    const result = await resolveCommandsSystemPromptBundle(params);

    expect(result.sandboxRuntime.sessionKey).toBe("agent:target:default");

    const promptParams = requireFirstArg(
      vi.mocked(buildAgentSystemPrompt),
      "buildAgentSystemPrompt",
    );
    const sandboxInfo = promptParams.sandboxInfo as
      | { enabled?: unknown; elevated?: Record<string, unknown> }
      | undefined;
    expect(sandboxInfo?.enabled).toBe(true);
    expect(sandboxInfo?.elevated?.fullAccessAvailable).toBe(false);
    expect(sandboxInfo?.elevated?.fullAccessBlockedReason).toBe("host-policy");
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

  it.each([true])("uses materialized sandbox skill paths (library=%s)", async (library) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-sandbox-skills-"));
    try {
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
        ...(library
          ? {
              librarySelections: [
                { skillId: "test-pin", revision: "revision-1", name: "gog", ownerProfileId: null },
              ],
            }
          : {}),
      };
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: gog", "description: Gog skill", "---", "# Gog", ""].join("\n"),
        "utf8",
      );
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
        snapshotVersion: "host-snapshot",
      } as never);

      const result = await resolveCommandsSystemPromptBundle(params);

      expect(vi.mocked(ensureSandboxWorkspaceForSession)).toHaveBeenCalledWith({
        skillsSnapshot: vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.results[0]?.value
          .snapshot,
        config: params.cfg,
        sessionKey: "global",
        agentId: "target",
        workspaceDir,
      });
      expect(result.skillsPrompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md",
      );
      expect(result.skillsPrompt).not.toContain(hostSkillPath);
      expect(vi.mocked(resolveReusableWorkspaceSkillSnapshot)).toHaveBeenCalledOnce();
      const promptParams = requireFirstArg(
        vi.mocked(buildAgentSystemPrompt),
        "buildAgentSystemPrompt",
      );
      expect(promptParams.skillsPrompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md",
      );
      expect(String(promptParams.skillsPrompt)).not.toContain(hostSkillPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses config-backed prompt settings for the target agent", async () => {
    createOpenClawCodingToolsAsyncMock.mockReturnValue([{ name: "sessions_spawn" }] as never);
    const params = makeParams();
    params.cfg = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "prefer",
          },
        },
      },
    };

    await resolveCommandsSystemPromptBundle(params);

    const promptParams = requireFirstArg(
      vi.mocked(buildAgentSystemPrompt),
      "buildAgentSystemPrompt",
    );
    expect(promptParams.subagentDelegationMode).toBe("prefer");
    expect(promptParams.toolNames).toEqual(["sessions_spawn"]);
  });
});
