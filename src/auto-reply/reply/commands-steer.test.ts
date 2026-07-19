// Tests steer command persistence and retrieval for session guidance.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAuthorizationPrincipal } from "../../plugins/authorization-policy-context.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const steerRuntimeMocks = vi.hoisted(() => ({
  formatEmbeddedAgentQueueFailureSummary: vi.fn(),
  isEmbeddedAgentRunActive: vi.fn(),
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn(),
}));

vi.mock("./commands-steer.runtime.js", () => steerRuntimeMocks);

const { handleSteerCommand } = await import("./commands-steer.js");

const baseCfg = {
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

function buildParams(commandBody: string) {
  return buildCommandTestParams(commandBody, baseCfg);
}

function attachAuthenticatedSenderAuthority(
  params: ReturnType<typeof buildCommandTestParams>,
): void {
  const principal = createAuthorizationPrincipal({
    provider: params.command.channel || params.command.surface,
    accountId: params.command.accountId,
    senderId: params.command.senderId,
    senderIsOwner: params.command.senderIsOwner,
    isAuthorizedSender: params.command.isAuthorizedSender,
    roleIds: params.command.memberRoleIds,
  });
  const controllerKey =
    principal.kind === "sender"
      ? ["sender", principal.provider, principal.accountId, principal.senderId]
          .filter(Boolean)
          .join(":")
      : undefined;
  params.ctx.TurnAuthority = createTurnAuthoritySnapshot({
    principal,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.ctx.NativeChannelId,
    parentConversationId: params.ctx.ThreadParentId,
    threadId: params.ctx.MessageThreadId ?? params.ctx.TransportThreadId,
    trigger: "channel",
    controllerKey,
  });
}

describe("handleSteerCommand", () => {
  beforeEach(() => {
    steerRuntimeMocks.formatEmbeddedAgentQueueFailureSummary
      .mockReset()
      .mockReturnValue(
        "queue_message_failed reason=not_streaming sessionId=session-active gatewayHealth=live",
      );
    steerRuntimeMocks.isEmbeddedAgentRunActive.mockReset().mockReturnValue(false);
    steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync.mockReset().mockResolvedValue({
      queued: true,
      sessionId: "session-active",
      target: "embedded_run",
      gatewayHealth: "live",
    });
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReset().mockReturnValue(undefined);
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionIdBySessionFile
      .mockReset()
      .mockReturnValue(undefined);
  });

  it("queues steering for the active current text-command session", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");

    const result = await handleSteerCommand(buildParams("/steer keep going"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered current session." },
    });
    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:main",
    );
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-active",
      "keep going",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: { incomplete: true },
        debounceMs: 0,
        taskSuggestionDeliveryMode: undefined,
      },
    );
  });

  it("passes the initiating surface task capability into steering", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    const params = buildParams("/steer keep going");
    params.opts = { taskSuggestionDeliveryMode: "gateway" };

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-active",
      "keep going",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: { incomplete: true },
        debounceMs: 0,
        taskSuggestionDeliveryMode: "gateway",
      },
    );
  });

  it("prefers the native command target session key over the slash-command session", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-target");

    const params = buildParams("/steer check the target");
    params.ctx.CommandSource = "native";
    params.ctx.CommandTargetSessionKey = "agent:main:discord:direct:target";
    params.sessionKey = "agent:main:discord:slash:user";

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:discord:direct:target",
    );
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-target",
      "check the target",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: { incomplete: true },
        debounceMs: 0,
        taskSuggestionDeliveryMode: undefined,
      },
    );
  });

  it("falls back to the stored session id when it is still active", async () => {
    steerRuntimeMocks.isEmbeddedAgentRunActive.mockReturnValue(true);

    const params = buildParams("/tell continue from state");
    params.sessionEntry = { sessionId: "stored-session-id", updatedAt: Date.now() };

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:main",
    );
    expect(steerRuntimeMocks.isEmbeddedAgentRunActive).toHaveBeenCalledWith("stored-session-id");
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "stored-session-id",
      "continue from state",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: { incomplete: true },
        debounceMs: 0,
        taskSuggestionDeliveryMode: undefined,
      },
    );
  });

  it("resolves an active run from the target session file before stored session id fallback", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionIdBySessionFile.mockReturnValue(
      "session-file-active",
    );

    const params = buildParams("/steer check the active file");
    params.ctx.CommandSource = "native";
    params.ctx.CommandTargetSessionKey = "agent:main:telegram:topic:5907";
    params.sessionKey = "agent:main:telegram:control";
    params.sessionStore = {
      "agent:main:telegram:topic:5907": {
        sessionId: "stored-session-id",
        sessionFile: "/tmp/openclaw-topic-5907.jsonl",
        updatedAt: Date.now(),
      },
    };

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:telegram:topic:5907",
    );
    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionIdBySessionFile).toHaveBeenCalledWith(
      "/tmp/openclaw-topic-5907.jsonl",
    );
    expect(steerRuntimeMocks.isEmbeddedAgentRunActive).not.toHaveBeenCalledWith(
      "stored-session-id",
    );
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-file-active",
      "check the active file",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: { incomplete: true },
        debounceMs: 0,
        taskSuggestionDeliveryMode: undefined,
      },
    );
  });

  it("falls back from a slash-lane command session to an active direct sibling", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockImplementation((key: string) =>
      key === "agent:main:telegram:direct:123" ? "session-direct-active" : undefined,
    );

    const params = buildCommandTestParams("/steer use the active direct lane", baseCfg, {
      Provider: "telegram",
      Surface: "telegram",
      AccountId: "molty",
      SenderId: "maintainer",
      CommandAuthorized: true,
      NativeChannelId: "123",
    });
    params.agentId = "main";
    params.sessionKey = "agent:main:telegram:slash:123";
    attachAuthenticatedSenderAuthority(params);

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenNthCalledWith(
      1,
      "agent:main:telegram:slash:123",
    );
    expect(steerRuntimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenNthCalledWith(
      2,
      "agent:main:telegram:direct:123",
    );
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-direct-active",
      "use the active direct lane",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: expect.objectContaining({
          kind: "authority",
          authority: expect.objectContaining({
            authorization: expect.objectContaining({
              principal: {
                provider: "telegram",
                accountId: "molty",
                senderId: "maintainer",
                senderIsOwner: false,
                isAuthorizedSender: true,
                kind: "sender",
              },
              agentId: "main",
              sessionKey: "agent:main:telegram:direct:123",
              conversationId: "123",
            }),
            controllerKey: "sender:telegram:molty:maintainer",
          }),
        }),
        debounceMs: 0,
        taskSuggestionDeliveryMode: undefined,
      },
    );
  });

  it("binds a session-file match to its canonical direct sibling key", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionIdBySessionFile.mockImplementation(
      (sessionFile: string) =>
        sessionFile === "/tmp/openclaw-direct-123.jsonl" ? "session-file-active" : undefined,
    );

    const params = buildCommandTestParams("/steer use the active file", baseCfg, {
      Provider: "telegram",
      Surface: "telegram",
      AccountId: "molty",
      SenderId: "maintainer",
      CommandAuthorized: true,
      NativeChannelId: "123",
    });
    params.agentId = "main";
    params.sessionKey = "agent:main:telegram:slash:123";
    params.sessionStore = {
      "agent:main:telegram:direct:123": {
        sessionId: "stored-session-id",
        sessionFile: "/tmp/openclaw-direct-123.jsonl",
        updatedAt: Date.now(),
      },
    };
    attachAuthenticatedSenderAuthority(params);

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-file-active",
      "use the active file",
      expect.objectContaining({
        steeringAuthorizationAffinity: expect.objectContaining({
          kind: "authority",
          authority: expect.objectContaining({
            authorization: expect.objectContaining({
              sessionKey: "agent:main:telegram:direct:123",
            }),
          }),
        }),
      }),
    );
  });

  it("returns usage for an empty steer command", async () => {
    const result = await handleSteerCommand(buildParams("/steer"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /steer <message>" },
    });
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("continues as a normal prompt when no current session run is active", async () => {
    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.Body).toBe("keep going");
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect((params.ctx as Record<string, unknown>).BodyStripped).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("continues as a normal prompt when the active run rejects steering injection", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync.mockResolvedValue({
      queued: false,
      sessionId: "session-active",
      reason: "not_streaming",
      gatewayHealth: "live",
    });

    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(steerRuntimeMocks.formatEmbeddedAgentQueueFailureSummary).toHaveBeenCalledWith({
      queued: false,
      sessionId: "session-active",
      reason: "not_streaming",
      gatewayHealth: "live",
    });
  });

  it("binds channel identity to /steer and falls back on an affinity mismatch", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync.mockResolvedValue({
      queued: false,
      sessionId: "session-active",
      reason: "authorization_affinity_mismatch",
      gatewayHealth: "live",
    });
    const sessionKey = "agent:main:discord:channel:maintenance";
    const params = buildCommandTestParams("/steer inspect this", baseCfg, {
      Provider: "discord",
      Surface: "discord",
      AccountId: "molty",
      SenderId: "maintainer",
      CommandAuthorized: true,
      NativeChannelId: "thread-1",
      ThreadParentId: "maintenance",
      MessageThreadId: "thread-1",
      MemberRoleIds: ["writers", "maintainers"],
    });
    params.agentId = "main";
    params.sessionKey = sessionKey;
    attachAuthenticatedSenderAuthority(params);

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("inspect this");
    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-active",
      "inspect this",
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        steeringAuthorizationAffinity: expect.objectContaining({
          kind: "authority",
          authority: expect.objectContaining({
            authorization: expect.objectContaining({
              principal: {
                provider: "discord",
                accountId: "molty",
                senderId: "maintainer",
                senderIsOwner: false,
                isAuthorizedSender: true,
                roleIds: ["maintainers", "writers"],
                kind: "sender",
              },
              agentId: "main",
              sessionKey,
              conversationId: "thread-1",
              parentConversationId: "maintenance",
              threadId: "thread-1",
            }),
            controllerKey: "sender:discord:molty:maintainer",
          }),
        }),
        debounceMs: 0,
        taskSuggestionDeliveryMode: undefined,
      },
    );
  });

  it("binds Slack direct-routed steering to its transport thread", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    const sessionKey = "agent:main:slack:direct:U123";
    const params = buildCommandTestParams("/steer continue this thread", baseCfg, {
      Provider: "slack",
      Surface: "slack",
      AccountId: "molty",
      SenderId: "maintainer",
      CommandAuthorized: true,
      ChatType: "direct",
      NativeChannelId: "D123",
      TransportThreadId: "1712345678.123456",
    });
    params.agentId = "main";
    params.sessionKey = sessionKey;
    attachAuthenticatedSenderAuthority(params);

    await handleSteerCommand(params, true);

    expect(steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-active",
      "continue this thread",
      expect.objectContaining({
        steeringAuthorizationAffinity: expect.objectContaining({
          kind: "authority",
          authority: expect.objectContaining({
            authorization: expect.objectContaining({
              agentId: "main",
              sessionKey,
              conversationId: "D123",
              threadId: "1712345678.123456",
            }),
          }),
        }),
      }),
    );
  });

  it("continues as a normal prompt when steering throws", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync.mockRejectedValue(
      new Error("socket closed"),
    );

    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
  });

  it("continues as a normal prompt when the active run is compacting", async () => {
    steerRuntimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("session-active");
    steerRuntimeMocks.queueEmbeddedAgentMessageWithOutcomeAsync.mockResolvedValue({
      queued: false,
      sessionId: "session-active",
      reason: "compacting",
      gatewayHealth: "live",
    });

    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: true,
    });
    expect(params.ctx.BodyForAgent).toBe("keep going");
  });
});
