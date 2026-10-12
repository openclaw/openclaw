import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
} from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { makeRelayTransport } from "./index.test-support.js";
import { closeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { relaySessions } from "./state.js";

const cfg = { agents: { entries: { main: {} } } };

async function captureBridgeRequest(params: {
  providerConfig: RealtimeVoiceProviderConfig;
  forceAgentConsultOnFinalTranscript: boolean;
}): Promise<{ request: RealtimeVoiceBridgeCreateRequest | undefined; relaySessionId: string }> {
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
  const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
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

  async function capture(params: Parameters<typeof captureBridgeRequest>[0]) {
    const captured = await captureBridgeRequest(params);
    opened.push(captured.relaySessionId);
    return captured.request;
  }

  // Regression for #139278: forced consults suppress automatic audio turns, but
  // must not disable interruption. Both flags were derived from the same boolean.
  it.each([
    { forced: true, interrupt: undefined, expectedInterrupt: true },
    { forced: false, interrupt: undefined, expectedInterrupt: true },
    { forced: false, interrupt: false, expectedInterrupt: false },
    { forced: true, interrupt: false, expectedInterrupt: false },
  ])(
    "resolves forced audio routing $forced independently of interruption $interrupt",
    async ({ forced, interrupt, expectedInterrupt }) => {
      const request = await capture({
        providerConfig: interrupt === undefined ? {} : { interruptResponseOnInputAudio: interrupt },
        forceAgentConsultOnFinalTranscript: forced,
      });

      expect(request?.autoRespondToAudio).toBe(!forced);
      expect(request?.interruptResponseOnInputAudio).toBe(expectedInterrupt);
    },
  );
});
