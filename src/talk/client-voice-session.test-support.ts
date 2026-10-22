import { CLIENT_VOICE_MUTATION_DIGEST_POLICY } from "./client-voice-mutation-digest-owner.js";
import { readVoiceSessionRecord } from "./client-voice-session-store.js";
import "./client-voice-session.js";

type ClientVoiceSessionTestApi = {
  reset(): void;
};

function getTestApi(): ClientVoiceSessionTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceSessionTestApi")
  ] as ClientVoiceSessionTestApi;
}

export const clientVoiceSessionTesting = {
  digestDeliveryPolicy: CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  readRecord: readVoiceSessionRecord,
  reset(): void {
    getTestApi().reset();
  },
};
