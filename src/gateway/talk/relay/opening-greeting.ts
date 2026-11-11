import type { RealtimeVoiceBridgeSession } from "../../../talk/session-runtime.js";
import type { CreateTalkRealtimeRelaySessionParams, RelaySession } from "./state.js";

/** Validates mutually exclusive initial greeting and recovery metadata on `talk.session.create`. */
export function validateRelayOpeningCreateParams(
  params: {
    greeting?: string;
    recovery?: { interruptedForMs: number };
    voiceChangeId?: string;
  },
  mode: string,
  transport: string,
): string | null {
  if (params.recovery !== undefined) {
    if (mode !== "realtime" || transport !== "gateway-relay" || params.voiceChangeId) {
      return "A recovery notice requires a new realtime relay session";
    }
    if (params.greeting !== undefined) {
      return "A recovery notice cannot include an opening greeting";
    }
  }
  if (
    params.greeting !== undefined &&
    (mode !== "realtime" || transport !== "gateway-relay" || params.voiceChangeId)
  ) {
    return "An opening greeting requires a new realtime relay session";
  }
  return null;
}

/** Retains deferred opening authority after `talk.session.create` releases request facts. */
export function prepareRelayOpeningOptions(options: {
  greeting?: string;
  recovery?: { interruptedForMs: number };
  receivedAt: number;
  retainAuthority?: () => (() => void) | undefined;
  hasCurrentClientAuthority?: () => boolean;
  assertEnsuredTargetCurrent: () => void;
}): Pick<
  CreateTalkRealtimeRelaySessionParams,
  "greeting" | "recovery" | "releaseGreetingAuthority" | "assertGreetingAllowed"
> {
  if (options.greeting === undefined && options.recovery === undefined) {
    return {};
  }
  const retainedRelease = options.retainAuthority?.();
  let released = false;
  return {
    ...(options.greeting !== undefined ? { greeting: options.greeting.trim() } : {}),
    ...(options.recovery !== undefined
      ? {
          recovery: {
            interruptedForMs: options.recovery.interruptedForMs,
            receivedAt: options.receivedAt,
          },
        }
      : {}),
    releaseGreetingAuthority: retainedRelease
      ? () => {
          if (released) {
            return;
          }
          released = true;
          retainedRelease();
        }
      : undefined,
    assertGreetingAllowed: () => {
      if (options.hasCurrentClientAuthority?.() === false) {
        throw new Error("Talk greeting connection is no longer authorized");
      }
      options.assertEnsuredTargetCurrent();
    },
  };
}

/** Owns the one-time initial or resumed opening after provider and accepted-client readiness. */
export function createRelayOpeningGreeting(
  params: Pick<
    CreateTalkRealtimeRelaySessionParams,
    "greeting" | "recovery" | "assertGreetingAllowed" | "releaseGreetingAuthority"
  >,
  getActiveRelay: () => RelaySession | undefined,
  bridgeRef: { current?: RealtimeVoiceBridgeSession },
) {
  let providerReady = false;
  let clientReady = false;
  let requested = false;
  let releaseAuthority = params.releaseGreetingAuthority;
  const close = () => {
    requested = true;
    const release = releaseAuthority;
    releaseAuthority = undefined;
    release?.();
  };
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
    try {
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
      active.runAuthority?.assertCurrent();
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
    } finally {
      close();
    }
  };
  return {
    close,
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
