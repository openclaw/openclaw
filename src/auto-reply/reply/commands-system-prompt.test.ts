import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const { createOpenClawCodingToolsMock } = vi.hoisted(() => ({
  createOpenClawCodingToolsMock: vi.fn(() => []),
}));

vi.mock("../../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: vi.fn(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  })),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false, mode: "off" })),
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => ({ prompt: "", skills: [], resolvedSkills: [] })),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => "test-snapshot"),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => undefined),
  resolveSessionAgentIds: vi.fn(() => ({ sessionAgentId: "main" })),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5" })),
}));

vi.mock("../../agents/system-prompt-params.js", () => ({
  buildSystemPromptParams: vi.fn(() => ({
    runtimeInfo: { host: "unknown", os: "unknown", arch: "unknown", node: process.version },
    userTimezone: "UTC",
    userTime: "12:00 PM",
    userTimeFormat: "12h",
  })),
}));

vi.mock("../../agents/system-prompt.js", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => false),
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

describe("resolveCommandsSystemPromptBundle", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    createOpenClawCodingToolsMock.mockClear();
    createOpenClawCodingToolsMock.mockReturnValue([]);
    const piTools = await import("../../agents/pi-tools.js");
    vi.spyOn(piTools, "createOpenClawCodingTools").mockImplementation(
      createOpenClawCodingToolsMock,
    );
    const ttsRuntime = await import("../../tts/tts.js");
    vi.spyOn(ttsRuntime, "buildTtsSystemPromptHint").mockReturnValue(undefined);
  });

  it("opts command tool builds into gateway subagent binding", async () => {
    const { resolveCommandsSystemPromptBundle } = await import("./commands-system-prompt.js");
    await resolveCommandsSystemPromptBundle(makeParams());

    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
        sessionKey: "agent:main:default",
        workspaceDir: "/tmp/workspace",
        messageProvider: "telegram",
        senderId: "sender-1",
        senderName: "Alice",
        senderUsername: "alice_u",
        senderE164: "+15551234567",
      }),
    );
  });
});
