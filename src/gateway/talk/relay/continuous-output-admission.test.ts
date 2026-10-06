import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resolveRealtimeVoiceProviderCapabilities } from "../../../talk/provider-resolver.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createTalkRealtimeRelaySession, sendTalkRealtimeRelayAudio } from "./index.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { relaySessions } from "./state.js";

const activeRelaySessions = new Map<string, string>();

function createRelaySession(
  provider: RealtimeVoiceProviderPlugin,
  broadcastToConnIds: ReturnType<typeof vi.fn>,
) {
  const cfg = { agents: { entries: { main: { default: true } } } };
  const capabilities = resolveRealtimeVoiceProviderCapabilities({
    provider,
    providerConfig: {},
    cfg,
    surface: "gateway-relay",
  });
  const connId = "conn-1";
  const session = createTalkRealtimeRelaySession({
    context: { broadcastToConnIds, chatAbortControllers: new Map() } as never,
    connId,
    cfg,
    provider,
    providerConfig: {},
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    instructions: "brief",
    tools: [],
    sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
  });
  activeRelaySessions.set(session.relaySessionId, connId);
  return session;
}

describe("talk realtime relay continuous output admission", () => {
  usePersistentRelayTestState(activeRelaySessions);

  it("ignores idle continuous silence and remains available for successive replies", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const close = vi.fn();
    const provider = createIdleRelayProvider((request) => {
      bridgeRequest = request;
      return makeRelayTransport({ outputAudioMode: "continuous", close });
    });
    const broadcastToConnIds = vi.fn();
    const session = createRelaySession(provider, broadcastToConnIds);
    if (!bridgeRequest) {
      throw new Error("expected realtime bridge request");
    }
    const silence = Buffer.alloc(960);
    bridgeRequest.onAudio(silence);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(relaySessions.get(session.relaySessionId)?.harness.talk.activeTurnId).toBeUndefined();

    for (const responseId of ["response-1", "response-2"]) {
      bridgeRequest.onEvent?.({ direction: "server", type: "response.created", responseId });
      bridgeRequest.onAudio(silence);
      bridgeRequest.onResponseDone?.({ status: "completed", responseId });
      const count = broadcastToConnIds.mock.calls.length;
      bridgeRequest.onAudio(silence);
      expect(broadcastToConnIds).toHaveBeenCalledTimes(count);
    }
    const payloads = broadcastToConnIds.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(payloads.filter((payload) => payload.type === "audio")).toHaveLength(2);
    expect(payloads.filter((payload) => payload.type === "audioDone")).toHaveLength(2);
    expect(payloads.some((payload) => payload.type === "error")).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
  });

  it.each([
    { mode: "continuous", input: true, zero: true, accepted: true },
    { mode: "continuous", input: true, zero: false, accepted: true },
    { mode: "continuous", input: false, zero: false, accepted: false },
    { mode: "response", input: false, zero: true, accepted: false },
  ] as const)(
    "preserves output admission for $mode audio (input=$input, zero=$zero)",
    ({ mode, input, zero, accepted }) => {
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const provider = createIdleRelayProvider((request) => {
        bridgeRequest = request;
        return makeRelayTransport({ outputAudioMode: mode });
      });
      const broadcastToConnIds = vi.fn();
      const session = createRelaySession(provider, broadcastToConnIds);
      if (input) {
        void sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId: "conn-1",
          audioBase64: "AQI=",
        });
      }
      bridgeRequest?.onAudio(Buffer.alloc(960, zero ? 0 : 1));
      const payloads = broadcastToConnIds.mock.calls.map(
        (call) => call[1] as Record<string, unknown>,
      );
      expect(payloads.some((payload) => payload.type === "audio")).toBe(accepted);
      expect(payloads.some((payload) => payload.type === "error")).toBe(!accepted);
    },
  );
});
