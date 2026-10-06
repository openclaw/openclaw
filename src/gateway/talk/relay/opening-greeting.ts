import type { RealtimeVoiceBridgeSession } from "../../../talk/session-runtime.js";
import type { CreateTalkRealtimeRelaySessionParams, RelaySession } from "./state.js";

/** Owns the one-time initial or resumed opening after provider and accepted-client readiness. */
export function createRelayOpeningGreeting(
  params: Pick<
    CreateTalkRealtimeRelaySessionParams,
    "greeting" | "recovery" | "assertGreetingAllowed"
  >,
  getActiveRelay: () => RelaySession | undefined,
  bridgeRef: { current?: RealtimeVoiceBridgeSession },
) {
  let providerReady = false;
  let clientReady = false;
  let requested = false;
  const request = () => {
    const active = getActiveRelay();
    if (
      (!params.greeting && !params.recovery) ||
      requested ||
      !providerReady ||
      !clientReady ||
      !active ||
      active.closing
    ) {
      return;
    }
    // Readiness can repeat; consume before checking retained authority or invoking
    // the provider. A revoked or failed greeting is never retried on a later frame.
    requested = true;
    let instructions = params.greeting ?? "";
    if (params.recovery) {
      const interruptedForMs =
        params.recovery.interruptedForMs +
        Math.max(0, performance.now() - params.recovery.receivedAt);
      // Consume short gaps too: later readiness notifications are not another outage.
      if (interruptedForMs <= 10_000) {
        return;
      }
      instructions =
        `Connection event, not a user utterance: the caller's audio connection was interrupted for about ${Math.round(interruptedForMs / 1000)} seconds and has now resumed. ` +
        "Briefly acknowledge reconnection and continue from the last confirmed exchange. " +
        "Do not restart the opening, automatically replay speech, or assume the caller heard audio during the interruption.";
    }
    try {
      params.assertGreetingAllowed?.();
      if (getActiveRelay() !== active || active.closing) {
        return;
      }
      if (Date.now() >= active.expiresAtMs) {
        throw new Error("Talk greeting session expired");
      }
      const bridge = bridgeRef.current;
      if (bridge?.bridge.triggerGreeting) {
        bridge.triggerGreeting(instructions);
      } else if (bridge?.bridge.sendUserMessage) {
        bridge.sendUserMessage(instructions);
      } else {
        throw new Error("Realtime provider does not support an opening greeting");
      }
    } catch {
      active.failSession("The opening greeting could not start. Restart the call.");
    }
  };
  return {
    noteProviderReady: () => {
      providerReady = true;
      request();
    },
    noteClientAudioAdmitted: () => {
      // An admitted frame proves relay ID adoption and playout initialization.
      // A silent frame is enough; recorded microphone audio is not required.
      clientReady = true;
      request();
    },
  };
}
