import type { RealtimeTalkGatewayRelaySessionResult } from "./shared.ts";

export function createGatewayRelaySession(
  provider = "openai",
  relaySessionId = "relay-1",
): RealtimeTalkGatewayRelaySessionResult {
  return {
    provider,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}
