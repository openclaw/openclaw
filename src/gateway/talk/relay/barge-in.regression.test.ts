import { describe, expect, it, vi } from "vitest";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { useRelayFixtures } from "./fixture.test-support.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";

const cfg = { agents: { entries: { main: {} } } };

describe("Talk relay barge-in under forced agent consults", () => {
  const createRelay = useRelayFixtures();

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
      const createBridge = vi.fn((_request: RealtimeVoiceBridgeCreateRequest) =>
        makeRelayTransport(),
      );
      const provider = createIdleRelayProvider(createBridge);
      const providerConfig =
        interrupt === undefined ? {} : { interruptResponseOnInputAudio: interrupt };
      const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
        provider,
        providerConfig,
        cfg,
        surface: "gateway-relay",
      });
      await createRelay({
        context: { broadcastToConnIds: vi.fn() } as never,
        cfg,
        provider,
        providerConfig,
        controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
        capabilities,
        forceAgentConsultOnFinalTranscript: forced,
      });
      expect(createBridge.mock.calls[0]?.[0]).toMatchObject({
        autoRespondToAudio: !forced,
        interruptResponseOnInputAudio: expectedInterrupt,
      });
    },
  );
});
