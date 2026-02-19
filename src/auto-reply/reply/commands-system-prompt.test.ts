import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

// Mock the machine name to make tests deterministic
vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn().mockResolvedValue("test-machine"),
}));

// Mock dependencies
vi.mock("../../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: vi.fn().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  }),
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn().mockReturnValue({
    prompt: "",
    skills: [],
    resolvedSkills: [],
  }),
}));

vi.mock("../../agents/pi-tools.js", () => ({
  createOpenClawCodingTools: vi.fn().mockReturnValue([]),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn().mockReturnValue({
    sandboxed: false,
  }),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn().mockReturnValue({}),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn().mockReturnValue("1.0.0"),
}));

// Helper function to extract runtime info from system prompt
function extractRuntimeInfo(systemPrompt: string): Record<string, string> {
  const runtimeMatch = systemPrompt.match(/Runtime: (.+)/);
  if (!runtimeMatch) {
    throw new Error("Runtime line not found in system prompt");
  }

  const runtimeLine = runtimeMatch[1];
  const pairs = runtimeLine.split(" | ");
  const runtime: Record<string, string> = {};

  for (const pair of pairs) {
    const [key, value] = pair.split("=");
    if (key && value) {
      runtime[key] = value;
    }
  }

  return runtime;
}

describe("resolveCommandsSystemPromptBundle - channel-aware runtime", () => {
  let baseParams: HandleCommandsParams;

  beforeEach(() => {
    baseParams = {
      workspaceDir: "/test/workspace",
      sessionKey: "test-session",
      sessionEntry: {
        sessionId: "test-session-id",
      },
      ctx: {
        SessionKey: "test-session",
      },
      cfg: {
        channels: {
          telegram: {
            capabilities: ["inlineButtons"],
          },
        },
        telegram: {
          inlineButtons: "dm",
        },
      },
      command: {
        surface: "telegram",
        channel: "telegram",
        ownerList: ["test-user"],
        senderIsOwner: true,
        isAuthorizedSender: true,
        rawBodyNormalized: "test command",
        commandBodyNormalized: "test command",
      },
      provider: "anthropic",
      model: "claude-3-sonnet",
      elevated: {
        allowed: false,
      },
      resolvedElevatedLevel: "off",
      resolvedThinkLevel: "low",
      resolvedReasoningLevel: "off",
      directives: {
        cleaned: "",
        hasThinkDirective: false,
        hasVerboseDirective: false,
        hasReasoningDirective: false,
        hasElevatedDirective: false,
        hasModelDirective: false,
        hasStatusDirective: false,
        hasExecDirective: false,
        hasQueueDirective: false,
      },
      defaultGroupActivation: () => "mention",
      resolvedVerboseLevel: "off",
      resolveDefaultThinkingLevel: () => Promise.resolve("low"),
      contextTokens: 128000,
      isGroup: false,
    } as HandleCommandsParams;
  });

  it("includes channel=telegram when OriginatingChannel is telegram", async () => {
    const params = {
      ...baseParams,
      ctx: {
        ...baseParams.ctx,
        OriginatingChannel: "telegram",
      },
    };

    const result = await resolveCommandsSystemPromptBundle(params);
    const runtimeInfo = extractRuntimeInfo(result.systemPrompt);

    expect(runtimeInfo.channel).toBe("telegram");
  });

  it("omits channel when OriginatingChannel is undefined", async () => {
    const params = {
      ...baseParams,
      ctx: {
        ...baseParams.ctx,
        OriginatingChannel: undefined,
      },
    };

    const result = await resolveCommandsSystemPromptBundle(params);
    const runtimeInfo = extractRuntimeInfo(result.systemPrompt);

    expect(runtimeInfo.channel).toBeUndefined();
  });

  it("includes capabilities when channel is telegram and configured", async () => {
    const params = {
      ...baseParams,
      ctx: {
        ...baseParams.ctx,
        OriginatingChannel: "telegram",
      },
    };

    const result = await resolveCommandsSystemPromptBundle(params);
    const runtimeInfo = extractRuntimeInfo(result.systemPrompt);

    expect(runtimeInfo.capabilities).toContain("inlineButtons");
  });

  it("includes real host, os, and arch values instead of 'unknown'", async () => {
    const params = {
      ...baseParams,
      ctx: {
        ...baseParams.ctx,
        OriginatingChannel: "telegram",
      },
    };

    const result = await resolveCommandsSystemPromptBundle(params);
    const runtimeInfo = extractRuntimeInfo(result.systemPrompt);

    expect(runtimeInfo.host).toBe("test-machine");
    expect(runtimeInfo.os).toMatch(/\S+\s+\S+\s+\(\S+\)/); // Should be like "Darwin 25.2.0 (arm64)"
    expect(runtimeInfo.node).toMatch(/^v\d+\.\d+\.\d+/); // Should be like "v22.17.0"
  });

  it("includes shell information when available", async () => {
    const params = {
      ...baseParams,
      ctx: {
        ...baseParams.ctx,
        OriginatingChannel: "telegram",
      },
    };

    const result = await resolveCommandsSystemPromptBundle(params);
    const runtimeInfo = extractRuntimeInfo(result.systemPrompt);

    // Shell should be detected or undefined, but not hardcoded as "unknown"
    if (runtimeInfo.shell) {
      expect(runtimeInfo.shell).not.toBe("unknown");
    }
  });

  it("omits capabilities when channel is unknown", async () => {
    const params = {
      ...baseParams,
      ctx: {
        ...baseParams.ctx,
        OriginatingChannel: undefined,
      },
    };

    const result = await resolveCommandsSystemPromptBundle(params);
    const runtimeInfo = extractRuntimeInfo(result.systemPrompt);

    expect(runtimeInfo.capabilities).toBeUndefined();
  });

  it("includes model information correctly", async () => {
    const params = {
      ...baseParams,
      ctx: {
        ...baseParams.ctx,
        OriginatingChannel: "telegram",
      },
      provider: "anthropic",
      model: "claude-3-sonnet",
    };

    const result = await resolveCommandsSystemPromptBundle(params);
    const runtimeInfo = extractRuntimeInfo(result.systemPrompt);

    expect(runtimeInfo.model).toBe("anthropic/claude-3-sonnet");
  });
});
