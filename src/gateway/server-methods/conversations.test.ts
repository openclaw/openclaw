import { describe, expect, it, vi } from "vitest";
import { ConversationTurnInputError } from "../conversation-turn.js";
import { createConversationHandlers } from "./conversations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const request = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  turnId: "conversation-turn-1",
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  message: "hello molty",
  timeoutMs: 30_000,
};

const result = {
  status: "replied" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  correlationPersisted: true,
  reply: {
    conversationRef: request.conversationRef,
    messageId: "reef-inbound-1",
    replyToId: "reef-outbound-1",
    text: "hello clawd",
    timestamp: 300,
  },
};

function context(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
}

function invoke(params: {
  handler: NonNullable<ReturnType<typeof createConversationHandlers>["conversations.turn"]>;
  context: GatewayRequestContext;
  respond: RespondFn;
  request?: Record<string, unknown>;
}) {
  return params.handler({
    params: params.request ?? request,
    respond: params.respond,
    context: params.context,
    req: { type: "req", id: "1", method: "conversations.turn" },
    client: null,
    isWebchatConnect: () => false,
  });
}

describe("conversations.turn Gateway handler", () => {
  it("validates requests before entering the correlation service", async () => {
    const runConversationTurn = vi.fn();
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const respond = vi.fn<RespondFn>();

    await invoke({ handler, context: context(), respond, request: { agentId: "main" } });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("joins concurrent retries and replays the completed idempotent result", async () => {
    let finish: ((value: typeof result) => void) | undefined;
    const runConversationTurn = vi.fn(
      async () =>
        await new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
    );
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const gatewayContext = context();
    const firstRespond = vi.fn<RespondFn>();
    const secondRespond = vi.fn<RespondFn>();
    const first = invoke({ handler, context: gatewayContext, respond: firstRespond });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());
    const second = invoke({ handler, context: gatewayContext, respond: secondRespond });
    finish?.(result);
    await Promise.all([first, second]);

    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(firstRespond).toHaveBeenCalledWith(true, result, undefined, { channel: "reef" });
    expect(secondRespond).toHaveBeenCalledWith(true, result, undefined, {
      channel: "reef",
      cached: true,
    });

    const cachedRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: cachedRespond });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(cachedRespond).toHaveBeenCalledWith(true, result, undefined, { cached: true });
  });

  it("maps unsupported conversation input to a stable invalid-request response", async () => {
    const runConversationTurn = vi.fn(async () => {
      throw new ConversationTurnInputError("Channel matrix does not support correlated turns");
    });
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const respond = vi.fn<RespondFn>();

    await invoke({ handler, context: context(), respond });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Channel matrix does not support correlated turns",
      }),
      expect.any(Object),
    );
  });

  it("cancels an abandoned turn through the active Gateway connection", async () => {
    const cancelConversationTurn = vi.fn(() => true);
    const handlers = createConversationHandlers({
      cancelConversationTurn,
      runConversationTurn: vi.fn(),
    });
    const handler = handlers["conversations.turn.cancel"]!;
    const respond = vi.fn<RespondFn>();

    await handler({
      params: { turnId: request.turnId },
      respond,
      context: context(),
      req: { type: "req", id: "2", method: "conversations.turn.cancel" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(cancelConversationTurn).toHaveBeenCalledWith(request.turnId);
    expect(respond).toHaveBeenCalledWith(true, { cancelled: true }, undefined);
  });
});
