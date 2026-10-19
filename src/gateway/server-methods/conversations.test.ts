import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { cancelPendingConversationTurn } from "../../sessions/conversation-turns.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "../conversation-errors.js";
import { runGatewayConversationList } from "../conversation-list.js";
import { runGatewayConversationSend } from "../conversation-send.js";
import { runGatewayConversationTurn } from "../conversation-turn.js";
import { conversationHandlers } from "./conversations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

vi.mock("../../sessions/conversation-turns.js", () => ({ cancelPendingConversationTurn: vi.fn() }));
vi.mock("../conversation-list.js", () => ({ runGatewayConversationList: vi.fn() }));
vi.mock("../conversation-send.js", () => ({ runGatewayConversationSend: vi.fn() }));
vi.mock("../conversation-turn.js", () => ({ runGatewayConversationTurn: vi.fn() }));

beforeEach(() => vi.resetAllMocks());
const runConversationList = vi.mocked(runGatewayConversationList);
const runConversationSend = vi.mocked(runGatewayConversationSend);
const runConversationTurn = vi.mocked(runGatewayConversationTurn);
const cancelConversationTurn = vi.mocked(cancelPendingConversationTurn);

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

const sendRequest = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  operationId: "conversation-send-1",
  conversationRef: request.conversationRef,
  message: "hello molty",
};

const sendResult = {
  status: "sent" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  queueId: "conversation-send-1",
};

const adminClient = {
  connect: { scopes: ["operator.admin"] },
} as never;

function caller(
  method = "conversations.turn",
  defaults: Record<string, unknown> = request,
  client: GatewayClient | null = adminClient,
) {
  const gatewayContext = {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
  const invoke = (respond: RespondFn, params = defaults) =>
    conversationHandlers[method]!({
      params,
      respond,
      context: gatewayContext,
      req: { type: "req", id: "1", method },
      client,
      isWebchatConnect: () => false,
    });
  return {
    gatewayContext,
    invoke,
    query: async (params = defaults) => {
      const respond = vi.fn<RespondFn>();
      await invoke(respond, params);
      return respond;
    },
  };
}

function expectFailure(
  respond: RespondFn,
  error: { code: string; message?: string } = { code: "INVALID_REQUEST" },
  ...meta: unknown[]
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error), ...meta);
}

function expectReply(
  respond: RespondFn,
  payload = result,
  meta: Record<string, unknown> = { channel: "reef" },
) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined, meta);
}

describe("conversations.list Gateway handler", () => {
  it("runs discovery and listing inside the Gateway runtime", async () => {
    const listed = {
      conversations: [
        {
          conversationRef: request.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct" as const,
          target: "reef:molty",
          firstSeenAt: 100,
          lastSeenAt: 100,
        },
      ],
    };
    runConversationList.mockResolvedValue(listed);
    const { query } = caller("conversations.list", {
      agentId: "main",
      channel: "reef",
      query: "@molty",
      limit: 50,
    });
    const respond = await query();

    expect(runConversationList).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.any(Object),
        agentId: "main",
        channel: "reef",
        query: "@molty",
        limit: 50,
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, listed, undefined);
  });

  it("rejects invalid limits before directory discovery", async () => {
    const { query } = caller("conversations.list");
    const respond = await query({ agentId: "main", channel: "reef", limit: 101 });

    expect(runConversationList).not.toHaveBeenCalled();
    expectFailure(respond);
  });
});

it("conversations.send rejects operation-id reuse with different source input", async () => {
  runConversationSend.mockResolvedValue(sendResult);
  const { query } = caller("conversations.send", sendRequest);
  const respond = await query();
  expect(runConversationSend).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "main",
      senderIsOwner: true,
      sourceSessionKey: "agent:main:telegram:direct:operator",
      operationId: "conversation-send-1",
      conversationRef: request.conversationRef,
      message: "hello molty",
    }),
  );
  expect(respond).toHaveBeenCalledWith(true, sendResult, undefined, { channel: "reef" });

  const mismatchRespond = await query({
    ...sendRequest,
    sourceSessionKey: "agent:main:discord:channel:other",
  });
  expect(runConversationSend).toHaveBeenCalledOnce();
  expectFailure(mismatchRespond);
});

describe("conversations.turn Gateway handler", () => {
  it.each([
    {
      name: "foreign source owner",
      params: { ...request, sourceSessionKey: "agent:ops:main" },
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("ops") },
    },
    { name: "malformed request", params: { agentId: "main" }, error: { code: "INVALID_REQUEST" } },
  ])("rejects $name before entering the correlation service", async ({ params, error }) => {
    expectFailure(await caller().query(params), error);
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("joins concurrent retries and replays the completed idempotent result", async () => {
    const pending = createDeferred<typeof result>();
    runConversationTurn.mockReturnValue(pending.promise);
    const { invoke, query, gatewayContext } = caller();
    const firstRespond = vi.fn<RespondFn>();
    const secondRespond = vi.fn<RespondFn>();
    const first = invoke(firstRespond);
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());
    expect(runConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    const timeoutMismatchRespond = await query({ ...request, timeoutMs: 5_000 });
    expectFailure(timeoutMismatchRespond);
    const second = invoke(secondRespond);
    pending.resolve(result);
    await Promise.all([first, second]);

    expect(runConversationTurn).toHaveBeenCalledOnce();
    expectReply(firstRespond);
    expectReply(secondRespond, result, { channel: "reef", cached: true });

    const cachedRespond = await query();
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(cachedRespond).toHaveBeenCalledWith(true, result, undefined, { cached: true });

    for (const key of gatewayContext.dedupe.keys()) {
      if (key.endsWith(":identity")) {
        gatewayContext.dedupe.delete(key);
      }
    }
    const mismatchedRespond = await query({ ...request, message: "different message" });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expectFailure(mismatchedRespond);
  });

  it("keeps concurrent turn IDs isolated between agents", async () => {
    const pending = createDeferred<typeof result>();
    const otherResult = { ...result, messageId: "reef-outbound-other" };
    runConversationTurn.mockImplementation(async ({ agentId }) =>
      agentId === "main" ? await pending.promise : otherResult,
    );
    const { invoke } = caller();
    const firstRespond = vi.fn<RespondFn>();
    const otherRespond = vi.fn<RespondFn>();
    const first = invoke(firstRespond);
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());

    const other = invoke(otherRespond, {
      ...request,
      agentId: "other-agent",
      sourceSessionKey: "agent:other-agent:telegram:direct:operator",
    });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledTimes(2));
    pending.resolve(result);
    await Promise.all([first, other]);

    expectReply(firstRespond);
    expectReply(otherRespond, otherResult);
  });

  it.each([
    { name: "transient outage", conflict: false, error: new Error("temporary outage") },
    {
      name: "durable conflict",
      conflict: true,
      error: new ConversationOperationConflictError("operation input changed"),
    },
  ])("allows an authoritative retry after $name", async ({ conflict, error }) => {
    runConversationTurn.mockRejectedValueOnce(error).mockResolvedValueOnce(result);
    const { query, gatewayContext } = caller();
    const failed = await query(conflict ? { ...request, message: "conflicting message" } : request);
    expectFailure(
      failed,
      { code: conflict ? "INVALID_REQUEST" : "UNAVAILABLE" },
      expect.any(Object),
    );
    if (conflict) {
      expect([...gatewayContext.dedupe.keys()].some((key) => key.endsWith(":identity"))).toBe(
        false,
      );
    }
    const retried = await query();
    expect(runConversationTurn).toHaveBeenCalledTimes(2);
    expectReply(retried);
  });

  it("maps unsupported conversation input to a stable invalid-request response", async () => {
    runConversationTurn.mockRejectedValue(
      new ConversationInputError("Channel matrix does not support correlated turns"),
    );
    const { query } = caller();
    const respond = await query();

    const error = {
      code: "INVALID_REQUEST",
      message: "Channel matrix does not support correlated turns",
    };
    expectFailure(respond, error, expect.any(Object));

    const retryRespond = await query();
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expectFailure(retryRespond, error, { cached: true });
  });

  it("cancels an abandoned turn through the active Gateway connection", async () => {
    cancelConversationTurn.mockReturnValue(true);
    const { query } = caller(
      "conversations.turn.cancel",
      {
        agentId: request.agentId,
        turnId: request.turnId,
      },
      null,
    );
    const respond = await query();

    expect(cancelConversationTurn).toHaveBeenCalledWith({
      agentId: request.agentId,
      id: request.turnId,
    });
    expect(respond).toHaveBeenCalledWith(true, { cancelled: true }, undefined);
  });
});
