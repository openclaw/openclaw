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
