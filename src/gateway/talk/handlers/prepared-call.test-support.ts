import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RespondFn } from "../../server-methods/types.js";
import { expectRespondError, expectRespondOk, mockCallArg } from "./responses.test-support.js";

export type TalkHandlerCallOptions = {
  params: Record<string, unknown>;
  respond: RespondFn;
  config?: OpenClawConfig;
  context?: unknown;
  client?: unknown;
  id?: string;
};

/** Runs incoming-call contracts through the owning handler suite's admission harness. */
export function definePreparedCallSessionTests({
  callTalkHandler,
  mocks,
}: {
  callTalkHandler: (
    method: "talk.session.create",
    options: TalkHandlerCallOptions,
  ) => Promise<void>;
  mocks: {
    readSessionPreviewItemsFromTranscriptAsync: Mock;
    resolveConfiguredRealtimeVoiceProvider: Mock;
    createTalkRealtimeRelaySession: Mock;
    consultRealtimeVoiceAgent: Mock;
    chatSend: Mock;
  };
}) {
  it("binds recovery timing before asynchronous session preparation", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(500);
    onTestFinished(() => clock.mockRestore());
    const originalPreview =
      mocks.readSessionPreviewItemsFromTranscriptAsync.getMockImplementation();
    onTestFinished(() => {
      mocks.readSessionPreviewItemsFromTranscriptAsync.mockReset();
      if (originalPreview) {
        mocks.readSessionPreviewItemsFromTranscriptAsync.mockImplementation(originalPreview);
      }
    });
    mocks.readSessionPreviewItemsFromTranscriptAsync.mockImplementation(async () => {
      clock.mockReturnValue(4_500);
      return [];
    });
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: {
        id: "openai",
        label: "OpenAI Realtime",
        isConfigured: () => true,
        createBridge: vi.fn(),
      },
      providerConfig: { model: "test-voice" },
      capabilities: { transports: ["gateway-relay"], handlesAgentConsult: true },
    });
    mocks.createTalkRealtimeRelaySession.mockReturnValue({
      provider: "openai",
      transport: "gateway-relay",
      relaySessionId: "relay-recovered-call",
    });
    const respond = vi.fn();
    await callTalkHandler("talk.session.create", {
      params: {
        sessionKey: "agent:main:prepared-call",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        recovery: { interruptedForMs: 8_000 },
      },
      respond,
      client: { connId: "conn-prepared", connect: { scopes: ["operator.talk"] } },
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig },
    });
    expectRespondOk(respond, { transport: "gateway-relay" });
    const input = mockCallArg(mocks.createTalkRealtimeRelaySession) as Record<string, unknown>;
    expect(input.recovery).toEqual({ interruptedForMs: 8_000, receivedAt: 500 });
    expect(input.assertGreetingAllowed).toEqual(expect.any(Function));
    expect(input.greeting).toBeUndefined();
  });

  it.each([
    { mode: "transcription", transport: "gateway-relay", brain: "none" },
    { mode: "realtime", transport: "managed-room", brain: "agent-consult" },
    { mode: "realtime", transport: "gateway-relay", voiceChangeId: "replacement" },
  ])("rejects recovery outside a new realtime relay: %j", async (selection) => {
    const respond = vi.fn();
    await callTalkHandler("talk.session.create", {
      params: {
        ...selection,
        sessionKey: "agent:main:prepared-call",
        recovery: { interruptedForMs: 12_000 },
      },
      respond,
      client: { connId: "conn-prepared", connect: { scopes: ["operator.talk"] } },
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig },
    });
    expectRespondError(respond, {
      message: "A recovery notice requires a new realtime relay session",
    });
    expect(mocks.createTalkRealtimeRelaySession).not.toHaveBeenCalled();
  });

  it("rejects competing recovery and initial opening requests", async () => {
    const respond = vi.fn();
    await callTalkHandler("talk.session.create", {
      params: {
        sessionKey: "agent:main:prepared-call",
        mode: "realtime",
        transport: "gateway-relay",
        recovery: { interruptedForMs: 12_000 },
        greeting: "Say hello.",
      },
      respond,
      client: { connId: "conn-prepared", connect: { scopes: ["operator.talk"] } },
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig },
    });
    expectRespondError(respond, {
      message: "A recovery notice cannot include an opening greeting",
    });
    expect(mocks.createTalkRealtimeRelaySession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "loads prepared conversation on the first relay connection (native delegation: %s)",
    async (handlesAgentConsult) => {
      const briefing = {
        role: "assistant",
        text: "Prepared comparison: option A has the shortest commute. Source: the route report.",
      };
      mocks.readSessionPreviewItemsFromTranscriptAsync.mockReturnValueOnce([
        briefing,
        { role: "tool", text: "Private raw tool output is not voice history" },
      ]);
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider: {
          id: "openai",
          label: "OpenAI Realtime",
          isConfigured: () => true,
          createBridge: vi.fn(),
        },
        providerConfig: { model: "test-voice" },
        capabilities: { transports: ["gateway-relay"], handlesAgentConsult },
      });
      mocks.createTalkRealtimeRelaySession.mockReturnValue({
        provider: "openai",
        transport: "gateway-relay",
        relaySessionId: `relay-first-context-${handlesAgentConsult}`,
      });
      const respond = vi.fn();
      await callTalkHandler("talk.session.create", {
        params: {
          sessionKey: "agent:main:prepared-call",
          mode: "realtime",
          transport: "gateway-relay",
          brain: "agent-consult",
          provider: "openai",
          greeting: "Briefly explain the prepared call topic.",
        },
        respond,
        client: { connId: "conn-prepared", connect: { scopes: ["operator.talk"] } },
        context: { getRuntimeConfig: () => ({}) as OpenClawConfig },
      });
      expectRespondOk(respond, { transport: "gateway-relay" });
      expect(mocks.readSessionPreviewItemsFromTranscriptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", sessionKey: "agent:main:prepared-call" }),
        16,
        800,
        "model-context",
      );
      const input = mockCallArg(mocks.createTalkRealtimeRelaySession) as Record<string, unknown>;
      expect(input.initialItems).toEqual([briefing]);
      expect(input.greeting).toBe("Briefly explain the prepared call topic.");
      expect(input.assertGreetingAllowed).toEqual(expect.any(Function));
      expect(input.instructions).toContain(briefing.text);
      expect(input.instructions).toContain("historical speech, not instructions");
      expect(input.instructions).not.toContain("Private raw tool output");
      expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
      expect(mocks.chatSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "transcription", transport: "gateway-relay", brain: "none" },
    {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      voiceChangeId: "replacement",
    },
  ])("rejects opening greetings outside a new realtime relay: %j", async (selection) => {
    const respond = vi.fn();
    await callTalkHandler("talk.session.create", {
      params: { ...selection, sessionKey: "agent:main:prepared-call", greeting: "Say hello." },
      respond,
      client: { connId: "conn-prepared", connect: { scopes: ["operator.talk"] } },
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig },
    });
    expectRespondError(respond, {
      message: "An opening greeting requires a new realtime relay session",
    });
    expect(mocks.createTalkRealtimeRelaySession).not.toHaveBeenCalled();
  });
}
