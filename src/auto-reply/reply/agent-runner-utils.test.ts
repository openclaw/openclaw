import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import type { FollowupRun } from "./queue.js";

type ThreadingParams = Parameters<NonNullable<ChannelThreadingAdapter["buildToolContext"]>>[0];

const hoisted = vi.hoisted(() => ({
  resolveModelFallbackAvailabilityMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
  isReasoningTagProviderMock: vi.fn(),
}));

vi.mock("../../agents/model-selection-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-selection-config.js")>()),
  resolveModelFallbackAvailability: (...args: unknown[]) =>
    hoisted.resolveModelFallbackAvailabilityMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => hoisted.getChannelPluginMock(...args),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (...args: unknown[]) => hoisted.isReasoningTagProviderMock(...args),
}));

const {
  buildThreadingToolContext,
  buildEmbeddedRunExecutionParams,
  mintReplyMessageActionTurnCapability,
} = await import("./agent-runner-utils.js");
const {
  resolveCurrentPromptReaction,
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} = await import("../../gateway/message-action-turn-capability.js");
const { setChannelSourceTurnId } = await import("./source-turn-id.js");

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config: { models: { providers: {} } },
    provider: "openai",
    model: "gpt-4.1",
    requestedRouteResolution: "resolved",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkingCatalog: [
      { provider: "openai", id: "gpt-4.1-mini", input: ["text"] },
      { provider: "minimax", id: "MiniMax-M2.7", input: ["text"] },
      { provider: "anthropic", id: "claude-sonnet-4-6", input: ["text"] },
    ],
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "none",
    execOverrides: {},
    bashElevated: false,
    timeoutMs: 60_000,
    ...overrides,
  } as unknown as FollowupRun["run"];
}

function buildExecution(params: Partial<Parameters<typeof buildEmbeddedRunExecutionParams>[0]>) {
  return buildEmbeddedRunExecutionParams({
    run: makeRun(),
    sessionCtx: {},
    hasRepliedRef: undefined,
    provider: "openai",
    model: "gpt-4.1-mini",
    runId: "run-1",
    ...params,
  });
}

describe("agent-runner-utils", () => {
  beforeEach(() => {
    hoisted.resolveModelFallbackAvailabilityMock.mockReset();
    hoisted.resolveModelFallbackAvailabilityMock.mockReturnValue({ kind: "none_configured" });
    hoisted.getChannelPluginMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReturnValue(false);
  });

  describe("message action turn capabilities", () => {
    const source = {
      agentId: "agent-1",
      runId: "dashboard-run",
      sessionKey: "agent:agent-1:dashboard:reads",
      sessionId: "session-1",
    };
    function makeTurn(): Parameters<typeof mintReplyMessageActionTurnCapability>[0] {
      return {
        followupRun: {
          prompt: "read channel",
          enqueuedAt: 0,
          run: makeRun({ sessionKey: source.sessionKey }),
        },
        sessionCtx: { Provider: "webchat" },
        opts: {
          runId: source.runId,
          dashboardReadAdmission: {
            ...source,
            assertCurrent: vi.fn(),
          },
        },
      };
    }

    it("mints host-only dashboard authority for the original admitted identity", () => {
      const turn = makeTurn();
      const now = Date.now();
      const token = mintReplyMessageActionTurnCapability(turn, source.runId);
      const lookup = { ...source, token };
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(now + turn.followupRun.run.timeoutMs + 60_001);
      try {
        const authority = resolveMessageActionTurnAuthorization(lookup);
        expect(authority?.assertDashboardReadCurrent).toBeTypeOf("function");
        expect(resolveCurrentPromptReaction(lookup)).toBeUndefined();
        expect(authority).not.toHaveProperty("currentPromptReaction");
        expect(resolveMessageActionTurnCapability(lookup)).not.toHaveProperty(
          "currentPromptReaction",
        );
        authority?.assertDashboardReadCurrent?.();
        expect(turn.opts?.dashboardReadAdmission?.assertCurrent).toHaveBeenCalled();
        expect(resolveMessageActionTurnCapability(lookup)).not.toHaveProperty(
          "assertDashboardReadCurrent",
        );
      } finally {
        clock.mockRestore();
        revokeMessageActionTurnCapability(token);
      }
    });

    it("rejects inherited dashboard options outside their admitted source", () => {
      const turn = makeTurn();
      const queued = { ...turn, opts: { ...turn.opts, runId: "followup-run" } };
      const mismatches = [
        { agentId: "another-agent" },
        { sessionKey: "agent:agent-1:dashboard:another" },
        { sessionId: "another-session" },
      ].map((change) => {
        const mismatch = makeTurn();
        Object.assign(mismatch.followupRun.run, change);
        return mismatch;
      });
      for (const candidate of [queued, ...mismatches, { ...turn, opts: { runId: source.runId } }]) {
        const token = mintReplyMessageActionTurnCapability(
          candidate,
          candidate.opts?.runId ?? source.runId,
        );
        revokeMessageActionTurnCapability(token);
        expect(token).toBeUndefined();
      }
      expect(turn.opts?.dashboardReadAdmission?.assertCurrent).not.toHaveBeenCalled();
    });

    it("keeps native Discord context when dashboard options are present", () => {
      const turn = makeTurn();
      turn.sessionCtx = { Provider: "discord", To: "channel:123", AccountId: "work" };
      const token = mintReplyMessageActionTurnCapability(turn, source.runId);
      try {
        const authority = resolveMessageActionTurnAuthorization({ ...source, token });
        expect(authority).toMatchObject({
          requesterAccountId: "work",
          toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:123" },
        });
        expect(authority?.assertDashboardReadCurrent).toBeUndefined();
        expect(resolveCurrentPromptReaction({ ...source, token })).toBeUndefined();
        expect(turn.opts?.dashboardReadAdmission?.assertCurrent).not.toHaveBeenCalled();
      } finally {
        revokeMessageActionTurnCapability(token);
      }
    });
  });

  it("uses the queued conversation policy snapshot", async () => {
    const run = makeRun({ conversationToolPolicy: { deny: ["exec"] } });

    const resolved = await buildExecution({
      run,
      sessionCtx: {
        Provider: "telegram",
        ConversationToolPolicy: { deny: ["write"] },
      },
    });

    expect(resolved.conversationToolPolicy).toEqual({ deny: ["exec"] });
  });

  it("builds embedded contexts and scopes auth profile by provider", async () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
      chatType: "direct",
    });

    const resolved = await buildExecution({
      run,
      sessionCtx: {
        Provider: "OpenAI",
        To: "channel-1",
        ChatType: "Channel",
        NativeChannelId: "native-chat-1",
        SenderId: "sender-1",
        ChannelContext: {
          sender: { id: "sender-1", providerUserId: "provider-user-1" },
          chat: { id: "native-chat-1", topicId: "topic-1" },
        },
        MemberRoleIds: ["admin", " ", "operator"],
        media: [{ contentType: "audio/ogg; codecs=opus", kind: "audio" }],
      },
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        authProfileId: undefined,
        authProfileIdSource: undefined,
        sessionId: run.sessionId,
        sessionKey: run.sessionKey,
        agentId: run.agentId,
        messageProvider: "openai",
        chatType: "channel",
        messageTo: "channel-1",
        chatId: "native-chat-1",
        memberRoleIds: ["admin", "operator"],
        currentInboundAudio: true,
        senderId: "sender-1",
        channelContext: run.channelContext,
        senderName: undefined,
        senderUsername: undefined,
        senderE164: undefined,
      }),
    );
  });

  it("hydrates the queued route before resolving channel threading policy", async () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({ accountId, context }: ThreadingParams) => ({
          currentChannelId: context.NativeChannelId ?? context.To,
          currentMessagingTarget: context.To,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          replyToMode: accountId === "work" && context.ChatType === "direct" ? "off" : "all",
        }),
      },
    });
    const run = makeRun({ agentAccountId: "work", chatType: "direct" });

    const resolved = await buildExecution({
      run,
      sessionCtx: {
        Provider: "cron-event",
        NativeChannelId: "D1",
        SessionKey: "agent:main:main:thread:1234:42",
        MessageThreadId: "stale-topic",
      },
      replyRoute: {
        originatingChannel: "slack",
        originatingTo: "user:U1",
        originatingAccountId: "work",
        originatingChatType: "direct",
        originatingThreadId: 42,
      },
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        messageProvider: "slack",
        messageTo: "user:U1",
        currentChannelId: "D1",
        currentMessagingTarget: "user:U1",
        messageThreadId: 42,
        currentThreadTs: "42",
        agentAccountId: "work",
        chatType: "direct",
        replyToMode: "off",
        currentInboundAudio: false,
      }),
    );
  });

  it("carries prepared reply routing without leaking webchat identity", async () => {
    const resolved = await buildExecution({
      replyRoute: {
        originatingChannel: "reef",
        originatingTo: "reef:remote-agent",
        originatingReplyToMode: "all",
      },
      sessionCtx: {
        Provider: "webchat",
        To: "reef:local-agent",
        MessageSid: "message-1",
      },
    });

    expect(resolved).toMatchObject({
      currentChannelId: "reef:remote-agent",
      currentChannelProvider: "reef",
      currentMessageId: undefined,
      replyToMode: "all",
    });
  });

  it("uses OriginatingTo for threading tool context on discord native commands", () => {
    const sessionCtx = {
      Provider: "discord",
      To: "slash:1177378744822943744",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:123456789012345678",
      MessageSid: "msg-9",
    };
    setChannelSourceTurnId(sessionCtx, "channel-user:v1:source-9");
    const context = buildThreadingToolContext({
      sessionCtx,
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context).toEqual(
      expect.objectContaining({
        currentChannelId: "channel:123456789012345678",
        currentMessageId: "msg-9",
        currentSourceTurnId: "channel-user:v1:source-9",
      }),
    );
  });

  it("does not expose restart-sentinel synthetic ids as message-tool reply targets", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({ context }: ThreadingParams) => ({
          currentChannelId: context.To,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
        }),
      },
    });

    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622:topic:928",
        MessageThreadId: 928,
        MessageSid: "restart-sentinel:agent:main:telegram:agentTurn:123",
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "telegram",
          sourceTool: "restart-sentinel",
        },
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context).toEqual(
      expect.objectContaining({
        currentChannelId: "telegram:-1003841603622:topic:928",
        currentThreadTs: "928",
        currentMessageId: undefined,
      }),
    );
  });
});
