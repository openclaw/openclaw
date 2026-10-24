import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { useRelayFixtures } from "./fixture.test-support.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";
import { relaySessions } from "./state.js";

describe("talk realtime relay continuous output", () => {
  const createRelay = useRelayFixtures();

  it.each(["audio", "transcript"] as const)(
    "claims a Talk turn for continuous provider %s before browser audio",
    async (output) => {
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const { relay, relaySessionId } = await createRelay({
        provider: createIdleRelayProvider((input) => {
          request = input;
          return makeRelayTransport({ outputAudioMode: "continuous" });
        }),
      });
      const broadcast = vi.spyOn(relay.context, "broadcastToConnIds");
      if (output === "audio") {
        request?.onAudio(Buffer.from("greeting"));
      } else {
        request?.onTranscript?.("assistant", "Hello", false);
      }

      const payloads = broadcast.mock.calls.map((call) => call[1] as Record<string, unknown>);
      expect(payloads.filter((payload) => payload.type === "error")).toEqual([]);
      const turnId = relaySessions.get(relaySessionId)?.harness.talk.activeTurnId;
      expect(turnId).toEqual(expect.any(String));
      expect(payloads.find((payload) => payload.type === output)).toMatchObject({
        talkEvent: { turnId },
      });
    },
  );
});
