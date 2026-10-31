import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEmbeddedAgentHookContext } from "../../agents/embedded-agent-runner/run/agent-hook-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import { createRemoteControlUiIngressTestContext } from "../../gateway/remote-control-ui.test-support.js";
import { prepareTurn } from "../../gateway/server-methods/chat-send-user-turn-family.test-support.js";
import { createSessionMutationTestClient } from "../../gateway/server-methods/sessions-mutations.owner.test-support.js";
import type { GatewayClient } from "../../gateway/server-methods/shared-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getRequesterProfile } from "../requester-profile.js";
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
  buildModelResolveContext,
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

  describe("verified UI sender in agent hooks", () => {
    function prepareUiTurn(client: GatewayClient, assertCurrent?: () => void) {
      return prepareTurn({
        client,
        request: { clientInfo: client.connect.client },
        session: { sessionKey: "agent:agent-1:shared" },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          assertWorkAdmissionCurrent: assertCurrent,
        },
      }).ctx;
    }

    async function hookContexts(sessionCtx: ReturnType<typeof prepareUiTurn>) {
      const run = makeRun({ sessionKey: "agent:agent-1:shared" });
      const execution = await buildExecution({ run, sessionCtx });
      return [
        buildModelResolveContext({ run, sessionCtx, hasRepliedRef: undefined, trigger: "user" }),
        buildEmbeddedAgentHookContext({ ...execution, trigger: "user" }, run.agentId!, undefined),
      ];
    }

    it("keeps the current speaker distinct when people share a session", async () => {
      for (const profileId of ["profile-ada", "profile-grace", "profile-ada"]) {
        const ctx = prepareUiTurn(createSessionMutationTestClient(profileId));
        expect(ctx).not.toHaveProperty("SenderId");
        for (const hook of await hookContexts(ctx)) {
          expect(hook.senderId).toBe(profileId);
          expect(hook.channelContext?.sender?.id).toBe(profileId);
        }
      }
    });

    it("observes an admitted UI speaker inside agent execution without granting its authority", async () => {
      const client = createSessionMutationTestClient("profile-ada");
      const ctx = prepareUiTurn(client);
      await withGatewayToolCallerIdentity(
        { agentId: "agent-1", sessionKey: "agent:agent-1:shared" },
        async () => {
          const caller = getGatewayToolCallerIdentity();
          expect(getRequesterProfile(ctx)).toBeUndefined();
          for (const hook of await hookContexts(ctx)) {
            expect(hook.senderId).toBe("profile-ada");
          }
          expect(getGatewayToolCallerIdentity()).toBe(caller);
          client.invalidated = true;
          for (const hook of await hookContexts(ctx)) {
            expect(hook.senderId).toBeUndefined();
          }
          expect(getGatewayToolCallerIdentity()).toBe(caller);
        },
      );
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
    });

    it("does not acquire a UI speaker from an agent-originated ingress", async () => {
      await withGatewayToolCallerIdentity(
        { agentId: "agent-1", sessionKey: "agent:agent-1:shared" },
        async () => {
          const ctx = prepareUiTurn(createSessionMutationTestClient("profile-ada"));
          for (const hook of await hookContexts(ctx)) {
            expect(hook.senderId).toBeUndefined();
          }
        },
      );
    });

    it("does not turn a retired cached hook context into an owner memory write", async () => {
      const client = createSessionMutationTestClient("profile-ada");
      const contexts = await hookContexts(prepareUiTurn(client));
      const memoryRead = vi.fn((...args: unknown[]) => {
        const ctx = args[1];
        if (!ctx || typeof ctx !== "object") {
          throw new Error("Missing hook context");
        }
        expect(Object.getOwnPropertySymbols(ctx)).toHaveLength(0);
      });
      const claim = vi.fn(() => ({ handled: true }));
      const messageWrite = vi.fn();
      const memoryWrite = vi.fn((...args: unknown[]) => {
        const ctx = args[1];
        return ctx && typeof ctx === "object" && "senderId" in ctx
          ? (ctx.senderId ?? "owner")
          : "owner";
      });
      const runner = createHookRunner(
        createMockPluginRegistry([
          { hookName: "before_prompt_build", pluginId: "personal-memory", handler: memoryRead },
          { hookName: "agent_end", pluginId: "personal-memory", handler: memoryWrite },
          { hookName: "before_agent_reply", pluginId: "personal-memory", handler: claim },
          { hookName: "before_message_write", pluginId: "personal-memory", handler: messageWrite },
        ]),
      );
      for (const ctx of contexts) {
        await runner.runBeforePromptBuild({ prompt: "hello", messages: [] }, ctx);
        await runner.runAgentEnd({ success: true, messages: [] }, ctx);
        await runner.runBeforeAgentReply({ cleanedBody: "hello" }, ctx);
        runner.runBeforeMessageWrite(
          { message: { role: "user", content: "hello", timestamp: 1 } },
          { ...ctx, agentId: "agent-1", sessionKey: "agent:agent-1:shared" },
        );
      }
      expect(memoryRead).toHaveBeenCalledTimes(2);
      expect(memoryWrite.mock.results.map((result) => result.value)).toEqual([
        "profile-ada",
        "profile-ada",
      ]);
      client.invalidated = true;
      for (const ctx of contexts) {
        await runner.runBeforePromptBuild({ prompt: "hello", messages: [] }, ctx);
        await runner.runAgentEnd({ success: false, messages: [] }, ctx);
        await runner.runBeforeAgentReply({ cleanedBody: "hello" }, ctx);
        runner.runBeforeMessageWrite(
          { message: { role: "user", content: "hello", timestamp: 1 } },
          { ...ctx, agentId: "agent-1", sessionKey: "agent:agent-1:shared" },
        );
      }
      expect(memoryRead).toHaveBeenCalledTimes(2);
      expect(memoryWrite).toHaveBeenCalledTimes(2);
      expect(claim).toHaveBeenCalledTimes(2);
      expect(messageWrite).toHaveBeenCalledTimes(2);
    });

    it.each([
      { heldIndex: 0, rejected: false },
      { heldIndex: 1, rejected: false },
      { heldIndex: 0, rejected: true },
      { heldIndex: 1, rejected: true },
    ])(
      "discards personal enrichment revoked during handler $heldIndex (rejected=$rejected)",
      async ({ heldIndex, rejected }) => {
        const client = createSessionMutationTestClient("profile-ada");
        const [ctx] = await hookContexts(prepareUiTurn(client));
        const entered = createDeferredCore();
        const finish = createDeferredCore();
        const handlers = [0, 1].map((index) =>
          vi.fn(async () => {
            if (index === heldIndex) {
              entered.resolve();
              await finish.promise;
              if (rejected) {
                throw new Error("Provider unavailable");
              }
            }
            return { prependContext: "personal memory" };
          }),
        );
        const runner = createHookRunner(
          createMockPluginRegistry(
            handlers.map((handler, index) => ({
              hookName: "before_prompt_build",
              pluginId: `memory-${index}`,
              priority: 2 - index,
              handler,
            })),
          ),
        );
        const pending = runner.runBeforePromptBuild({ prompt: "hello", messages: [] }, ctx!);
        await entered.promise;
        client.invalidated = true;
        finish.resolve();
        expect(await pending).toBeUndefined();
        expect(handlers[0]).toHaveBeenCalledOnce();
        expect(handlers[1]).toHaveBeenCalledTimes(heldIndex === 0 ? 0 : 1);
      },
    );

    it.each([false, true])("discards a revoked awaited claim (rejected=%s)", async (rejected) => {
      const client = createSessionMutationTestClient("profile-ada");
      const [ctx] = await hookContexts(prepareUiTurn(client));
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const next = vi.fn();
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_agent_reply",
            pluginId: "memory",
            priority: 2,
            handler: async () => {
              entered.resolve();
              await finish.promise;
              if (rejected) {
                throw new Error("Provider unavailable");
              }
              return { handled: true, reply: { text: "personal memory" } };
            },
          },
          { hookName: "before_agent_reply", pluginId: "next", priority: 1, handler: next },
        ]),
      );
      const pending = runner.runBeforeAgentReply({ cleanedBody: "hello" }, ctx!);
      await entered.promise;
      client.invalidated = true;
      finish.resolve();
      expect(await pending).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
    });

    it.each(["revoked", "aborted", "actor"])(
      "rechecks delegated UI profile authority: %s",
      async (change) => {
        const client = createSessionMutationTestClient("profile-ada");
        client.authenticatedUserId = undefined;
        const lifetime = new AbortController();
        let current = true;
        const principal = createRemoteControlUiIngressTestContext({
          principal: { kind: "person", profileId: "profile-ada" },
          signal: lifetime.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("Grant revoked");
            }
          },
        }).resolvePrincipal();
        client.internal = {
          authenticatedOperator: true,
          operatorRoleActor: principal.operatorRoleActor,
          remoteIngressPrincipal: principal,
        };
        const ctx = prepareUiTurn(client);
        expect((await hookContexts(ctx))[0]?.senderId).toBe("profile-ada");
        if (change === "revoked") {
          current = false;
        } else if (change === "aborted") {
          lifetime.abort();
        } else {
          client.internal.operatorRoleActor = { kind: "operator", profileId: "profile-grace" };
        }
        for (const hook of await hookContexts(ctx)) {
          expect(hook.senderId).toBeUndefined();
        }
      },
    );

    it.each([
      "profile",
      "identity",
      "binding",
      "json",
      "invalidated",
      "disconnect",
      "synthetic",
      "admission",
    ])("does not expose a retired UI requester after %s changes", async (change) => {
      const client = createSessionMutationTestClient("profile-ada");
      const lifetime = new AbortController();
      client.connectionSignal = lifetime.signal;
      let current = true;
      let ctx = prepareUiTurn(client, () => {
        if (!current) {
          throw new Error("Retired admission");
        }
      });
      if (change === "profile") {
        client.authenticatedUserProfile =
          createSessionMutationTestClient("profile-grace").authenticatedUserProfile;
      } else if (change === "identity") {
        client.authenticatedUserId = "another@example.test";
      } else if (change === "binding") {
        ctx.AccountId = "another-account";
      } else if (change === "json") {
        // Exercise transport serialization, not cloning: host capabilities must not survive JSON.
        // eslint-disable-next-line unicorn/prefer-structured-clone
        ctx = JSON.parse(JSON.stringify(ctx));
      } else if (change === "invalidated") {
        client.invalidated = true;
      } else if (change === "disconnect") {
        lifetime.abort();
      } else if (change === "synthetic") {
        client.internal = { syntheticClient: true };
      } else {
        current = false;
      }
      for (const hook of await hookContexts(ctx)) {
        expect(hook.senderId).toBeUndefined();
        expect(hook.channelContext?.sender).toBeUndefined();
      }
    });

    it.each(["unverified", "owner", "synthetic"])(
      "does not invent a sender for %s UI input",
      async (kind) => {
        const client = createSessionMutationTestClient("profile-ada");
        if (kind === "unverified") {
          client.authenticatedUserProfile = undefined;
        } else if (kind === "owner") {
          client.authenticatedUserId = undefined;
        } else {
          client.internal = { syntheticClient: true };
        }
        for (const hook of await hookContexts(prepareUiTurn(client))) {
          expect(hook.senderId).toBeUndefined();
        }
      },
    );
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
