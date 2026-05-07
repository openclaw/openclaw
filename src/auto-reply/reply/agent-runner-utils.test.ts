import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveEffectiveModelFallbacksMock = vi.fn();
  const resolveEffectiveToolPolicyMock = vi.fn();
  const resolveGroupToolPolicyMock = vi.fn();
  const getChannelPluginMock = vi.fn();
  const isReasoningTagProviderMock = vi.fn();
  return {
    resolveEffectiveModelFallbacksMock,
    resolveEffectiveToolPolicyMock,
    resolveGroupToolPolicyMock,
    getChannelPluginMock,
    isReasoningTagProviderMock,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveEffectiveModelFallbacks: (...args: unknown[]) =>
    hoisted.resolveEffectiveModelFallbacksMock(...args),
}));

vi.mock("../../agents/pi-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: (...args: unknown[]) =>
    hoisted.resolveEffectiveToolPolicyMock(...args),
  resolveGroupToolPolicy: (...args: unknown[]) => hoisted.resolveGroupToolPolicyMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => hoisted.getChannelPluginMock(...args),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (...args: unknown[]) => hoisted.isReasoningTagProviderMock(...args),
}));

const {
  buildThreadingToolContext,
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  buildEmbeddedRunExecutionParams,
  resolveEmbeddedRunToolsAllow,
  resolveModelFallbackOptions,
  resolveEnforceFinalTag,
  resolveProviderScopedAuthProfile,
} = await import("./agent-runner-utils.js");

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config: { models: { providers: {} } },
    provider: "openai",
    model: "gpt-4.1",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "none",
    execOverrides: {},
    bashElevated: false,
    timeoutMs: 60_000,
    ...overrides,
  } as unknown as FollowupRun["run"];
}

describe("agent-runner-utils", () => {
  beforeEach(() => {
    hoisted.resolveEffectiveModelFallbacksMock.mockClear();
    hoisted.resolveEffectiveToolPolicyMock.mockReset();
    hoisted.resolveEffectiveToolPolicyMock.mockReturnValue({});
    hoisted.resolveGroupToolPolicyMock.mockReset();
    hoisted.resolveGroupToolPolicyMock.mockReturnValue(undefined);
    hoisted.getChannelPluginMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReturnValue(false);
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({ hasSessionModelOverride: true, modelOverrideSource: "user" });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
    });
    expect(resolved).toEqual({
      cfg: run.config,
      provider: run.provider,
      model: run.model,
      agentDir: run.agentDir,
      fallbacksOverride: ["fallback-model"],
    });
  });

  it("passes through missing agentId for helper-based fallback resolution", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({ agentId: undefined });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: undefined,
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("builds embedded run base params with auth profile and run metadata", () => {
    const run = makeRun({ enforceFinalTag: true });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
    });

    const resolved = buildEmbeddedRunBaseParams({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile,
    });

    expect(resolved).toMatchObject({
      sessionFile: run.sessionFile,
      workspaceDir: run.workspaceDir,
      agentDir: run.agentDir,
      config: run.config,
      skillsSnapshot: run.skillsSnapshot,
      ownerNumbers: run.ownerNumbers,
      enforceFinalTag: true,
      provider: "openai",
      model: "gpt-4.1-mini",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
      thinkLevel: run.thinkLevel,
      verboseLevel: run.verboseLevel,
      reasoningLevel: run.reasoningLevel,
      execOverrides: run.execOverrides,
      bashElevated: run.bashElevated,
      timeoutMs: run.timeoutMs,
      runId: "run-1",
    });
  });

  it("derives embedded toolsAllow from explicit config allowlists", () => {
    const run = makeRun({
      config: {
        tools: {
          allow: ["example_plugin_tool"],
        },
        agents: {
          list: [
            {
              id: "agent-1",
              tools: {
                allow: ["example_plugin_tool"],
              },
            },
          ],
        },
      },
    });
    hoisted.resolveEffectiveToolPolicyMock.mockReturnValue({
      globalPolicy: { allow: ["example_plugin_tool"] },
      agentPolicy: { allow: ["example_plugin_tool"] },
    });

    expect(resolveEmbeddedRunToolsAllow({ run, provider: "openai", model: "gpt-5.5" })).toEqual([
      "example_plugin_tool",
    ]);
    expect(hoisted.resolveEffectiveToolPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: run.config,
        sessionKey: run.sessionKey,
        agentId: run.agentId,
        modelProvider: "openai",
        modelId: "gpt-5.5",
      }),
    );
  });

  it("passes explicit embedded toolsAllow through execution params", () => {
    const run = makeRun({
      config: {
        tools: {
          allow: ["example_plugin_tool"],
        },
      },
    });
    hoisted.resolveEffectiveToolPolicyMock.mockReturnValue({
      globalPolicy: { allow: ["example_plugin_tool"] },
    });
    const resolved = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: {
        Provider: "feishu",
        OriginatingChannel: "feishu",
        SenderId: "sender-1",
      },
      hasRepliedRef: undefined,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-1",
    });

    expect(resolved.runBaseParams).toMatchObject({
      toolsAllow: ["example_plugin_tool"],
    });
  });

  it("does not force final-tag enforcement for minimax providers", () => {
    const run = makeRun();

    expect(resolveEnforceFinalTag(run, "minimax", "MiniMax-M2.7")).toBe(false);
    expect(hoisted.isReasoningTagProviderMock).toHaveBeenCalledWith("minimax", {
      config: run.config,
      workspaceDir: run.workspaceDir,
      modelId: "MiniMax-M2.7",
    });
  });

  it("builds embedded contexts and scopes auth profile by provider", () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
    });

    const resolved = buildEmbeddedRunContexts({
      run,
      sessionCtx: {
        Provider: "OpenAI",
        To: "channel-1",
        SenderId: "sender-1",
        MemberRoleIds: ["admin", " ", "operator"],
      },
      hasRepliedRef: undefined,
      provider: "anthropic",
    });

    expect(resolved.authProfile).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(resolved.embeddedContext).toMatchObject({
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
      agentId: run.agentId,
      messageProvider: "openai",
      messageTo: "channel-1",
      memberRoleIds: ["admin", "operator"],
    });
    expect(resolved.senderContext).toEqual({
      senderId: "sender-1",
      senderName: undefined,
      senderUsername: undefined,
      senderE164: undefined,
    });
  });

  it("prefers OriginatingChannel over Provider for messageProvider", () => {
    const run = makeRun();

    const resolved = buildEmbeddedRunContexts({
      run,
      sessionCtx: {
        Provider: "heartbeat",
        OriginatingChannel: "Telegram",
        OriginatingTo: "268300329",
      },
      hasRepliedRef: undefined,
      provider: "openai",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("telegram");
    expect(resolved.embeddedContext.messageTo).toBe("268300329");
  });

  it("uses telegram plugin threading context for native commands", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          context,
          hasRepliedRef,
        }: {
          context: { To?: string; MessageThreadId?: string | number };
          hasRepliedRef?: { value: boolean };
        }) => ({
          currentChannelId: context.To?.trim() || undefined,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          hasRepliedRef,
        }),
      },
    });

    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "telegram",
        To: "slash:8460800771",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622",
        MessageThreadId: 928,
        MessageSid: "2284",
      },
      config: { channels: { telegram: { allowFrom: ["*"] } } },
      hasRepliedRef: undefined,
    });

    expect(context).toMatchObject({
      currentChannelId: "telegram:-1003841603622",
      currentThreadTs: "928",
      currentMessageId: "2284",
    });
  });

  it("uses OriginatingTo for threading tool context on discord native commands", () => {
    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "discord",
        To: "slash:1177378744822943744",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:123456789012345678",
        MessageSid: "msg-9",
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context).toMatchObject({
      currentChannelId: "channel:123456789012345678",
      currentMessageId: "msg-9",
    });
  });
});
