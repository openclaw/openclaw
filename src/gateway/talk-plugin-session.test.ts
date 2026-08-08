import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  createSession: vi.fn(),
  sendAudio: vi.fn(),
  cancelTurn: vi.fn(),
  stopSession: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: mocks.scope,
}));
vi.mock("./talk-realtime-session-create.js", () => ({
  createGatewayRealtimeTalkSession: mocks.createSession,
}));
vi.mock("./talk-realtime-relay.js", () => ({
  sendTalkRealtimeRelayAudio: mocks.sendAudio,
  cancelTalkRealtimeRelayTurn: mocks.cancelTurn,
  stopTalkRealtimeRelaySession: mocks.stopSession,
}));

import { openPluginTalkSession } from "./talk-plugin-session.js";

describe("plugin Talk session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.mockReturnValue({
      pluginId: "avatar",
      gatewayMethodDispatchAllowed: true,
      client: { connect: { scopes: ["operator.talk"] } },
      context: { logGateway: { warn: mocks.warn } },
    });
    mocks.createSession.mockResolvedValue({ relaySessionId: "relay-1" });
  });

  it("uses the shared Gateway session and maps owner-scoped media events", async () => {
    const onEvent = vi.fn();
    const session = await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      voice: "alloy",
      onEvent,
    });
    const createParams = mocks.createSession.mock.calls[0]?.[0];

    expect(createParams).toMatchObject({
      context: { logGateway: { warn: mocks.warn } },
      request: { sessionKey: "agent:main:avatar", voice: "alloy" },
    });
    expect(createParams.ownerId).toMatch(/^plugin:avatar:/);

    createParams.eventSink({ relaySessionId: "relay-1", type: "ready" });
    createParams.eventSink({ relaySessionId: "relay-1", type: "audioStarted" });
    createParams.eventSink({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: Buffer.from([1, 0]).toString("base64"),
    });
    createParams.eventSink({ relaySessionId: "relay-1", type: "clear", reason: "barge-in" });

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "state", generation: 0, ptsMs: 0, state: "listening" },
      { type: "state", generation: 0, ptsMs: 0, state: "speaking" },
      {
        type: "audio",
        generation: 0,
        sequence: 0,
        ptsMs: 0,
        pcm: Buffer.from([1, 0]),
      },
      { type: "clear", generation: 1, reason: "barge-in" },
      { type: "state", generation: 1, ptsMs: 0, state: "listening" },
    ]);

    session.sendAudio(new Uint8Array([2, 0]), { timestamp: 20 });
    session.cancelOutput("barge-in");
    session.close();

    expect(mocks.sendAudio).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
      audioBase64: "AgA=",
      timestamp: 20,
    });
    expect(mocks.cancelTurn).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
      reason: "barge-in",
    });
    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
    });
  });

  it("stops accepting media after the Gateway closes the session", async () => {
    const onEvent = vi.fn();
    const session = await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      onEvent,
    });
    const eventSink = mocks.createSession.mock.calls[0]?.[0].eventSink;

    eventSink({ relaySessionId: "relay-1", type: "close", reason: "error" });
    eventSink({ relaySessionId: "relay-1", type: "close", reason: "error" });

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      type: "closed",
      generation: 0,
      reason: "error",
    });
    expect(() => session.sendAudio(new Uint8Array([1, 0]))).toThrow("Talk session is closed");
    session.cancelOutput();
    session.close();
    expect(mocks.cancelTurn).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it("closes the relay when the plugin event callback fails", async () => {
    await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      onEvent: async () => {
        throw new Error("renderer gone");
      },
    });
    const createParams = mocks.createSession.mock.calls[0]?.[0];

    createParams.eventSink({ relaySessionId: "relay-1", type: "ready" });
    await vi.waitFor(() => expect(mocks.stopSession).toHaveBeenCalledOnce());

    expect(mocks.warn).toHaveBeenCalledWith("plugin Talk event delivery failed: renderer gone");
    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: createParams.ownerId,
    });
  });

  it("closes a session whose event callback fails during creation", async () => {
    mocks.createSession.mockImplementationOnce(async (params) => {
      params.eventSink({ relaySessionId: "relay-1", type: "ready" });
      return { relaySessionId: "relay-1" };
    });

    await expect(
      openPluginTalkSession({
        sessionKey: "agent:main:avatar",
        onEvent: () => {
          throw new Error("renderer gone");
        },
      }),
    ).rejects.toThrow("renderer gone");

    expect(mocks.stopSession).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: expect.stringMatching(/^plugin:avatar:/),
    });
  });

  it("rejects plugin routes without Talk access", async () => {
    mocks.scope.mockReturnValue({
      pluginId: "avatar",
      gatewayMethodDispatchAllowed: true,
      client: { connect: { scopes: ["operator.read"] } },
      context: { logGateway: { warn: mocks.warn } },
    });

    await expect(
      openPluginTalkSession({ sessionKey: "agent:main:avatar", onEvent: vi.fn() }),
    ).rejects.toThrow("authenticated plugin request with Talk access");
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("requires an entitled request scope and a selected agent session", async () => {
    mocks.scope.mockReturnValue(undefined);
    await expect(
      openPluginTalkSession({ sessionKey: "agent:main:avatar", onEvent: vi.fn() }),
    ).rejects.toThrow("gatewayMethodDispatch contract");

    await expect(openPluginTalkSession({ sessionKey: " ", onEvent: vi.fn() })).rejects.toThrow(
      "intended agent and workspace",
    );
  });
});
