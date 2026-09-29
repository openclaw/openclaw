import type { MeetingSessionRuntimeHandles } from "./session-runtime-types.js";
import type { MeetingBrowserHealth } from "./session-types.js";

export type MeetingSpeechReadinessMessages<TReason extends string> = {
  audioBridgeUnavailable: string;
  audioBridgeUnavailableReason: TReason;
  browserUnverified: string;
  browserUnverifiedReason: TReason;
  microphoneMuted: string;
  microphoneMutedReason: TReason;
  notInCall: string;
  notInCallReason: TReason;
};

export function evaluateMeetingSpeechReadiness<TReason extends string>(params: {
  browser:
    | {
        hasAudioBridge: boolean;
        health?: MeetingBrowserHealth<string, TReason>;
      }
    | undefined;
  managedBrowser: boolean;
  speech: MeetingSpeechReadinessMessages<TReason>;
  talkBack: boolean;
}): { ready: boolean; reason?: TReason; message?: string } {
  const { browser, speech } = params;
  if (!params.talkBack || !browser) {
    return { ready: true };
  }
  const health = params.managedBrowser ? browser.health : undefined;
  if (health?.manualAction) {
    return {
      ready: false,
      reason: health.manualAction.reason as TReason,
      message: health.manualAction.message,
    };
  }
  if (health?.inCall === true) {
    if (health.micMuted !== false) {
      const muted = health.micMuted === true;
      // Unknown is transiently blocked: omitted mic controls cannot prove talk-back readiness.
      return {
        ready: false,
        reason: muted ? speech.microphoneMutedReason : speech.browserUnverifiedReason,
        message: muted ? speech.microphoneMuted : speech.browserUnverified,
      };
    }
  } else if (health?.inCall === false) {
    return { ready: false, reason: speech.notInCallReason, message: speech.notInCall };
  } else if (params.managedBrowser) {
    return {
      ready: false,
      reason: speech.browserUnverifiedReason,
      message: speech.browserUnverified,
    };
  }
  return browser.hasAudioBridge
    ? { ready: true }
    : {
        ready: false,
        reason: speech.audioBridgeUnavailableReason,
        message: speech.audioBridgeUnavailable,
      };
}

/** Keep final native output checks bound to the session owner's live readiness. */
export async function submitMeetingSpeechWithReadiness(params: {
  speak: NonNullable<MeetingSessionRuntimeHandles<MeetingBrowserHealth>["speak"]>;
  instructions?: string;
  assertCurrent: () => void;
  refreshCurrent?: () => Promise<void>;
  refreshReadiness: () => { ready: boolean; message?: string };
  refreshBrowserHealth: () => Promise<void>;
  speechBlockedFallback: string;
  onBlocked: (message: string) => void;
}): Promise<boolean> {
  params.assertCurrent();
  const initial = params.refreshReadiness();
  if (!initial.ready) {
    params.onBlocked(
      initial.message
        ? `Realtime speech blocked: ${initial.message}`
        : params.speechBlockedFallback,
    );
    return false;
  }
  const assertReady = () => {
    params.assertCurrent();
    const readiness = params.refreshReadiness();
    if (!readiness.ready) {
      throw new Error(
        readiness.message
          ? `Realtime speech blocked: ${readiness.message}`
          : params.speechBlockedFallback,
      );
    }
  };
  assertReady();
  await params.speak(
    params.instructions,
    assertReady,
    // Presence selects exact source-backed speech, not the ordinary greeting path.
    params.refreshCurrent
      ? async () => {
          await params.refreshCurrent?.();
          assertReady();
          await params.refreshBrowserHealth();
          assertReady();
        }
      : undefined,
  );
  assertReady();
  return true;
}
