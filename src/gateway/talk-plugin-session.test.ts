import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  ensureSession: vi.fn(),
  resolveProvider: vi.fn(),
  createRelay: vi.fn(),
  sendAudio: vi.fn(),
  cancelTurn: vi.fn(),
  stopSession: vi.fn(),
}));

vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: mocks.scope,
}));
vi.mock("../talk/client-voice-session.js", () => ({
  ensureClientVoiceAgentSessionEntry: mocks.ensureSession,
}));
vi.mock("../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveProvider,
}));
vi.mock("./talk-realtime-relay.js", () => ({
  createTalkRealtimeRelaySession: mocks.createRelay,
  sendTalkRealtimeRelayAudio: mocks.sendAudio,
  cancelTalkRealtimeRelayTurn: mocks.cancelTurn,
  stopTalkRealtimeRelaySession: mocks.stopSession,
}));
vi.mock("./server-methods/talk-shared.js", () => ({
  buildTalkRealtimeConfig: () => ({ providers: {}, consultRouting: "force-agent-consult" }),
  buildRealtimeVoiceLaunchOptions: ({ requested }: { requested: object }) => requested,
  resolveTalkRealtimeProviderInstructions: async () => ({
    agentId: "main",
    instructions: "workspace context",
  }),
  buildRealtimeInstructions: (instructions: string) => instructions,
  withRealtimeBrowserOverrides: (config: object) => config,
}));

import { openPluginTalkSession } from "./talk-plugin-session.js";

describe("plugin Talk session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.mockReturnValue({
      pluginId: "avatar",
      gatewayMethodDispatchAllowed: true,
      context: {
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    });
    mocks.resolveProvider.mockReturnValue({ provider: { id: "openai" }, providerConfig: {} });
    mocks.createRelay.mockReturnValue({ relaySessionId: "relay-1" });
  });

  it("opens one Gateway-owned consult session and returns a scoped media handle", async () => {
    const events: unknown[] = [];
    const session = await openPluginTalkSession({
      sessionKey: "agent:main:avatar",
      voice: "alloy",
      onEvent: (event) => events.push(event),
    });
    const relayParams = mocks.createRelay.mock.calls[0]?.[0];

    expect(relayParams).toMatchObject({
      sessionKey: "agent:main:avatar",
      manageAgentConsult: true,
      forceAgentConsultOnFinalTranscript: true,
      voice: "alloy",
    });
    expect(relayParams.connId).toMatch(/^plugin:avatar:/);
    expect(mocks.ensureSession).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:avatar",
    });

    await relayParams.onOutputMediaEvent({
      type: "audio",
      generation: 1,
      sequence: 0,
      ptsMs: 0,
      pcm: new Uint8Array([1, 0]),
    });
    session.sendAudio(new Uint8Array([2, 0]), { timestamp: 20 });
    session.cancelOutput("barge-in");
    session.close();

    expect(events).toHaveLength(1);
    expect(mocks.sendAudio).toHaveBeenCalledWith(
      expect.objectContaining({ relaySessionId: "relay-1", audioBase64: "AgA=", timestamp: 20 }),
    );
    expect(mocks.cancelTurn).toHaveBeenCalledWith(
      expect.objectContaining({ relaySessionId: "relay-1", reason: "barge-in" }),
    );
    expect(mocks.stopSession).toHaveBeenCalledWith(
      expect.objectContaining({ relaySessionId: "relay-1" }),
    );
  });

  it("requires an entitled Gateway route and an agent session", async () => {
    mocks.scope.mockReturnValue(undefined);
    await expect(
      openPluginTalkSession({ sessionKey: "agent:main:avatar", onEvent: vi.fn() }),
    ).rejects.toThrow("Gateway-authenticated plugin routes");

    await expect(openPluginTalkSession({ sessionKey: " ", onEvent: vi.fn() })).rejects.toThrow(
      "intended OpenClaw agent and workspace",
    );
  });
});
