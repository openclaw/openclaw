import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  runPreparedReply: vi.fn(async (_args?: unknown) => ({ text: "ran" })),
  typingCleanup: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveAgentSkillsFilter: vi.fn(() => undefined),
}));
vi.mock("../../agents/model-selection.js", () => ({
  resolveModelRefFromString: vi.fn(() => null),
}));
vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 60000),
}));
vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/workspace",
  ensureAgentWorkspace: vi.fn(async () => ({ dir: "/tmp/workspace" })),
}));
vi.mock("../../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: vi.fn(() => undefined),
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: vi.fn(async () => undefined),
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: vi.fn(async () => undefined),
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));
vi.mock("../command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(() => ({ isAuthorizedSender: true })),
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: vi.fn(async () => undefined),
}));
vi.mock("./directive-handling.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: new Map(),
  })),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./get-reply-run.js", () => ({
  runPreparedReply: (args: unknown) => mocks.runPreparedReply(args),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));
vi.mock("./inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));
vi.mock("./message-preprocess-hooks.js", () => ({
  emitPreAgentMessageHooks: vi.fn(async () => undefined),
}));
vi.mock("./session-reset-model.js", () => ({
  applyResetModelOverride: vi.fn(async () => undefined),
}));
vi.mock("./stage-sandbox-media.js", () => ({
  stageSandboxMedia: vi.fn(async () => undefined),
}));
vi.mock("./typing.js", () => ({
  createTypingController: vi.fn(() => ({
    onReplyStart: async () => undefined,
    startTypingLoop: async () => undefined,
    startTypingOnText: async () => undefined,
    refreshTypingTtl: () => undefined,
    isActive: () => false,
    markRunComplete: () => undefined,
    markDispatchIdle: () => undefined,
    cleanup: mocks.typingCleanup,
  })),
}));

const { getReplyFromConfig } = await import("./get-reply.js");

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    ChatType: "group",
    Body: "hello team",
    BodyForAgent: "hello team",
    RawBody: "hello team",
    CommandBody: "hello team",
    SessionKey: "agent:main:telegram:-100123",
    From: "telegram:user:42",
    To: "telegram:-100123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

function createContinueDirectivesResult() {
  return {
    kind: "continue" as const,
    result: {
      commandSource: "",
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        ownerList: [],
        senderIsOwner: false,
        isAuthorizedSender: true,
        senderId: "42",
        abortKey: "agent:main:telegram:-100123",
        rawBodyNormalized: "hello team",
        commandBodyNormalized: "hello team",
        from: "telegram:user:42",
        to: "telegram:-100123",
        resetHookTriggered: false,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: "hello team",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      execOverrides: undefined,
      blockStreamingEnabled: false,
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: undefined,
      provider: "openai",
      model: "gpt-4o-mini",
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
      },
      contextTokens: 0,
      inlineStatusRequested: false,
      directiveAck: undefined,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
    },
  };
}

describe("getReplyFromConfig before_agent_run hook", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.runPreparedReply.mockReset();
    mocks.typingCleanup.mockReset();

    mocks.runPreparedReply.mockResolvedValue({ text: "ran" });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
    });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:-100123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: true,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });
  });

  it("passes before_agent_run context into the prepared reply stage", async () => {
    const result = await getReplyFromConfig(buildCtx(), undefined, {});

    expect(result).toEqual({ text: "ran" });
    expect(mocks.runPreparedReply).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeAgentRunContext: expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:telegram:-100123",
          sessionId: "session-1",
          workspaceDir: "/tmp/workspace",
          messageProvider: "telegram",
          channelId: "telegram",
          trigger: "user",
        }),
        agentId: "main",
      }),
    );
  });

  it("continues into the default agent run", async () => {
    const result = await getReplyFromConfig(buildCtx(), undefined, {});

    expect(result).toEqual({ text: "ran" });
    expect(mocks.runPreparedReply).toHaveBeenCalledTimes(1);
    expect(mocks.typingCleanup).not.toHaveBeenCalled();
  });

  it("passes heartbeat trigger context for heartbeat runs", async () => {
    await getReplyFromConfig(buildCtx(), { isHeartbeat: true }, {});

    expect(mocks.runPreparedReply).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeAgentRunContext: expect.objectContaining({
          messageProvider: "telegram",
          trigger: "heartbeat",
        }),
      }),
    );
  });
});
