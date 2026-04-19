import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const chatSendMock = vi.fn();

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    readSessionMessages: (...args: unknown[]) => readSessionMessagesMock(...args),
    loadGatewaySessionRow: () => undefined,
  };
});

vi.mock("../../agents/subagent-registry-read.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => undefined,
}));

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: () => false,
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

import { sessionsHandlers } from "./sessions.js";

function makeContext() {
  return {
    chatAbortControllers: new Map(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
  } as never;
}

function setupMocks(entry: Record<string, unknown>) {
  loadSessionEntryMock.mockReturnValue({
    canonicalKey: "agent:main:discord:user123",
    storePath: "/tmp/sessions.json",
    entry: { sessionId: "sess-ext", ...entry },
  });
  readSessionMessagesMock.mockReturnValue([]);
  chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "run-1", status: "started" }, undefined, undefined);
  });
}

describe("sessions.send external delivery context preservation", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessagesMock.mockReset();
    chatSendMock.mockReset();
  });

  it("passes deliver:true when session has deliveryContext with an external channel", async () => {
    setupMocks({
      deliveryContext: { channel: "discord", to: "user123", threadId: "thread-abc" },
    });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: { key: "agent:main:discord:user123", message: "follow-up" },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBe(true);
  });

  it("passes deliver:true when session has external lastChannel but no deliveryContext", async () => {
    setupMocks({ lastChannel: "telegram" });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: { key: "agent:main:telegram:peer456", message: "follow-up" },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBe(true);
  });

  it("does not pass deliver when session channel is webchat (internal)", async () => {
    setupMocks({ lastChannel: "webchat" });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: { key: "agent:main:webchat:user1", message: "hello" },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBeUndefined();
  });

  it("does not pass deliver when session has no channel info at all", async () => {
    setupMocks({});

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: { key: "agent:main:some-session", message: "hello" },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBeUndefined();
  });

  it("deliveryContext.channel takes precedence over lastChannel", async () => {
    setupMocks({
      deliveryContext: { channel: "discord", to: "user-dc" },
      lastChannel: "webchat",
    });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: { key: "agent:main:discord:user-dc", message: "follow-up" },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    // deliveryContext.channel is "discord" (external), so deliver should be true
    expect(chatSendParams.deliver).toBe(true);
  });

  it("passes explicitOrigin for ACP thread session with full delivery context", async () => {
    setupMocks({
      deliveryContext: {
        channel: "discord",
        to: "channel:1493256223175348355",
        accountId: "default",
        threadId: "1493256223175348355",
      },
    });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: "agent:codex:acp:4a00d0a1-89ef-48ab-8aae-2c03e27f033a",
        message: "Reply with exactly: THREAD_TEST_1",
      },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBe(true);
    // explicitOrigin fields bypass canInheritDeliverableRoute scope check
    expect(chatSendParams.originatingChannel).toBe("discord");
    expect(chatSendParams.originatingTo).toBe("channel:1493256223175348355");
    expect(chatSendParams.originatingThreadId).toBe("1493256223175348355");
    expect(chatSendParams.originatingAccountId).toBe("default");
  });

  it("does not pass explicitOrigin for ACP session without delivery context", async () => {
    setupMocks({});

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: "agent:codex:acp:internal-only-session",
        message: "internal message",
      },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBeUndefined();
    expect(chatSendParams.originatingChannel).toBeUndefined();
    expect(chatSendParams.originatingTo).toBeUndefined();
  });

  it("does not externalize ACP session with webchat-only delivery context", async () => {
    setupMocks({
      deliveryContext: { channel: "webchat" },
      lastChannel: "webchat",
    });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: "agent:codex:acp:webchat-session",
        message: "should stay internal",
      },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBeUndefined();
    expect(chatSendParams.originatingChannel).toBeUndefined();
  });

  it("prepends thread delivery framing when session has thread delivery context", async () => {
    setupMocks({
      deliveryContext: {
        channel: "discord",
        to: "channel:thread-123",
        accountId: "default",
        threadId: "thread-123",
      },
    });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: "agent:codex:acp:framing-test",
        message: "Reply with exactly: TEST_PAYLOAD",
      },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.message).toContain("[Thread delivery:");
    expect(chatSendParams.message).toContain("Reply with exactly: TEST_PAYLOAD");
  });

  it("does not prepend thread framing when session has no threadId", async () => {
    setupMocks({
      deliveryContext: { channel: "discord", to: "channel:some-channel" },
    });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: "agent:codex:acp:no-thread-test",
        message: "Regular message",
      },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.message).toBe("Regular message");
    expect(chatSendParams.message).not.toContain("[Thread delivery:");
  });

  it("explicitOrigin wins over stale lastChannel/lastTo", async () => {
    setupMocks({
      deliveryContext: {
        channel: "discord",
        to: "channel:correct-thread",
        threadId: "correct-thread",
      },
      // Stale fields that should be ignored in favor of deliveryContext
      lastChannel: "telegram",
      lastTo: "telegram:6098642967",
      lastThreadId: undefined,
    });

    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: "agent:codex:acp:stale-route-test",
        message: "should use deliveryContext, not lastChannel",
      },
      respond,
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(chatSendMock).toHaveBeenCalledTimes(1);
    const chatSendParams = chatSendMock.mock.calls[0][0].params;
    expect(chatSendParams.deliver).toBe(true);
    // Must use deliveryContext (discord), NOT stale lastChannel (telegram)
    expect(chatSendParams.originatingChannel).toBe("discord");
    expect(chatSendParams.originatingTo).toBe("channel:correct-thread");
    expect(chatSendParams.originatingThreadId).toBe("correct-thread");
  });
});
