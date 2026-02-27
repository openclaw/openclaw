import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  emitResetCommandHooks: vi.fn(),
  initSessionState: vi.fn(),
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
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
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
  runPreparedReply: vi.fn(async () => undefined),
}));
vi.mock("./inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));
vi.mock("./session-reset-model.js", () => ({
  applyResetModelOverride: vi.fn(async () => undefined),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
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
    cleanup: () => undefined,
  })),
}));

const { getReplyFromConfig } = await import("./get-reply.js");

function buildNativeResetContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "/new",
    RawBody: "/new",
    CommandBody: "/new",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    To: "slash:123",
  };
}

describe("getReplyFromConfig reset-hook fallback", () => {
  beforeEach(() => {
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.emitResetCommandHooks.mockReset();
    mocks.initSessionState.mockReset();

    mocks.initSessionState.mockResolvedValue({
      sessionCtx: buildNativeResetContext(),
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      isNewSession: true,
      resetTriggered: true,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "/new",
      bodyStripped: "",
    });

    mocks.resolveReplyDirectives.mockResolvedValue({
      kind: "continue",
      result: {
        commandSource: "/new",
        command: {
          surface: "telegram",
          channel: "telegram",
          channelId: "telegram",
          ownerList: [],
          senderIsOwner: true,
          isAuthorizedSender: true,
          senderId: "123",
          abortKey: "telegram:slash:123",
          rawBodyNormalized: "/new",
          commandBodyNormalized: "/new",
          from: "telegram:123",
          to: "slash:123",
          resetHookTriggered: false,
        },
        allowTextCommands: true,
        skillCommands: [],
        directives: {},
        cleanedBody: "/new",
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
    });
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    expect(mocks.emitResetCommandHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "new",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue({
      kind: "continue",
      result: {
        commandSource: "/new",
        command: {
          surface: "telegram",
          channel: "telegram",
          channelId: "telegram",
          ownerList: [],
          senderIsOwner: true,
          isAuthorizedSender: true,
          senderId: "123",
          abortKey: "telegram:slash:123",
          rawBodyNormalized: "/new",
          commandBodyNormalized: "/new",
          from: "telegram:123",
          to: "slash:123",
          resetHookTriggered: true,
        },
        allowTextCommands: true,
        skillCommands: [],
        directives: {},
        cleanedBody: "/new",
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
    });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });
});
