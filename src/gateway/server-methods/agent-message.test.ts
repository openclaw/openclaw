import { describe, expect, it, vi } from "vitest";
import { agentHandlers } from "./agent.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, loadConfig: () => ({}) };
});

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: vi.fn(),
  onAgentEvent: vi.fn(),
}));

const makeBroadcast = () => vi.fn();

const makeContext = (broadcast?: ReturnType<typeof vi.fn>): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
    broadcast: broadcast ?? makeBroadcast(),
  }) as unknown as GatewayRequestContext;

type AgentMessageHandlerArgs = Parameters<(typeof agentHandlers)["agent.message"]>[0];

async function invokeAgentMessage(
  params: AgentMessageHandlerArgs["params"],
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  const context = options?.context ?? makeContext();
  await agentHandlers["agent.message"]({
    params,
    respond: respond as never,
    context,
    req: { type: "req", id: "agent-message-test-req", method: "agent.message" },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("agent.message handler", () => {
  it("delivers a valid message and returns status delivered", async () => {
    const respond = await invokeAgentMessage({
      targetSessionKey: "agent:main:main",
      sourceSessionKey: "agent:helper:task-1",
      message: "hello from helper",
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      status: "delivered",
      ts: expect.any(Number),
    });
  });

  it("returns validation error when targetSessionKey is missing", async () => {
    const respond = await invokeAgentMessage({
      sourceSessionKey: "agent:helper:task-1",
      message: "hello",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent.message params"),
      }),
    );
  });

  it("returns validation error when sourceSessionKey is missing", async () => {
    const respond = await invokeAgentMessage({
      targetSessionKey: "agent:main:main",
      message: "hello",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent.message params"),
      }),
    );
  });

  it("returns validation error when message is missing", async () => {
    const respond = await invokeAgentMessage({
      targetSessionKey: "agent:main:main",
      sourceSessionKey: "agent:helper:task-1",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent.message params"),
      }),
    );
  });

  it("returns error for malformed target session key", async () => {
    const respond = await invokeAgentMessage({
      targetSessionKey: "not-a-valid-key",
      sourceSessionKey: "agent:helper:task-1",
      message: "hello",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed target session key"),
      }),
    );
  });

  it("returns error for malformed source session key", async () => {
    const respond = await invokeAgentMessage({
      targetSessionKey: "agent:main:main",
      sourceSessionKey: "bad-key",
      message: "hello",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed source session key"),
      }),
    );
  });

  it("round-trips correlationId through the response", async () => {
    const respond = await invokeAgentMessage({
      targetSessionKey: "agent:main:main",
      sourceSessionKey: "agent:helper:task-1",
      message: "hello",
      correlationId: "corr-abc-123",
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      status: "delivered",
      correlationId: "corr-abc-123",
    });
  });

  it("broadcasts agent.message event to connected clients", async () => {
    const broadcast = makeBroadcast();
    const context = makeContext(broadcast);

    await invokeAgentMessage(
      {
        targetSessionKey: "agent:main:main",
        sourceSessionKey: "agent:helper:task-1",
        message: "broadcast test",
        correlationId: "corr-bcast",
      },
      { context },
    );

    expect(broadcast).toHaveBeenCalledWith(
      "agent.message",
      expect.objectContaining({
        sourceSessionKey: "agent:helper:task-1",
        targetSessionKey: "agent:main:main",
        message: "broadcast test",
        correlationId: "corr-bcast",
        ts: expect.any(Number),
      }),
      { dropIfSlow: true },
    );
  });
});
