import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resolveRealtimeVoiceProviderCapabilities } from "../../../talk/provider-resolver.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
} from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createTalkRealtimeRelaySession } from "./index.js";
import { closeRelaySession } from "./operations.js";
import { relaySessions } from "./state.js";

const cfg = { agents: { entries: { main: { default: true } } } };

function makeRelayTransport(): RealtimeVoiceBridge {
  return {
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
  };
}

/**
 * Creates a relay session and returns the bridge request the provider received,
 * which carries the audio-turn and interruption flags the bridge gates on.
 */
function captureBridgeRequest(params: {
  providerConfig: RealtimeVoiceProviderConfig;
  forceAgentConsultOnFinalTranscript: boolean;
}): { request: RealtimeVoiceBridgeCreateRequest | undefined; relaySessionId: string } {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  const provider: RealtimeVoiceProviderPlugin = {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge: (req) => {
      request = req;
      return makeRelayTransport();
    },
  };
  const capabilities = resolveRealtimeVoiceProviderCapabilities({
    provider,
    providerConfig: params.providerConfig,
    cfg,
    surface: "gateway-relay",
  });
  const session = createTalkRealtimeRelaySession({
    context: {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
    } as never,
    connId: "conn-1",
    cfg,
    provider,
    providerConfig: params.providerConfig,
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    instructions: "be brief",
    tools: [],
    sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
    forceAgentConsultOnFinalTranscript: params.forceAgentConsultOnFinalTranscript,
  });
  return { request, relaySessionId: session.relaySessionId };
}

describe("Talk relay barge-in under forced agent consults", () => {
  let state: OpenClawTestState;
  const opened: string[] = [];

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-barge-in", applyEnv: true });
  });

  afterEach(async () => {
    for (const relaySessionId of opened.splice(0)) {
      const session = relaySessions.get(relaySessionId);
      if (session) {
        await closeRelaySession(session, "completed");
      }
    }
    await state.cleanup();
  });

  function capture(params: Parameters<typeof captureBridgeRequest>[0]) {
    const captured = captureBridgeRequest(params);
    opened.push(captured.relaySessionId);
    return captured.request;
  }

  // Regression for #139278: forced consults suppress automatic audio turns, but
  // must not disable interruption. Both flags were derived from the same boolean.
  it("keeps speech interruption armed while forced consults suppress audio turns", () => {
    const request = capture({
      providerConfig: {},
      forceAgentConsultOnFinalTranscript: true,
    });

    expect(request?.autoRespondToAudio).toBe(false);
    expect(request?.interruptResponseOnInputAudio).toBe(true);
  });

  it("leaves both enabled without forced consult routing", () => {
    const request = capture({
      providerConfig: {},
      forceAgentConsultOnFinalTranscript: false,
    });

    expect(request?.autoRespondToAudio).toBe(true);
    expect(request?.interruptResponseOnInputAudio).toBe(true);
  });

  it.each([false, true])(
    "honors an explicit provider opt-out with forced consult routing %s",
    (forceAgentConsultOnFinalTranscript) => {
      const request = capture({
        providerConfig: { interruptResponseOnInputAudio: false },
        forceAgentConsultOnFinalTranscript,
      });

      expect(request?.autoRespondToAudio).toBe(!forceAgentConsultOnFinalTranscript);
      expect(request?.interruptResponseOnInputAudio).toBe(false);
    },
  );
});
