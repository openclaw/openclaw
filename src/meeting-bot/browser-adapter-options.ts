import type { MeetingBrowserAudioCaptureRequest } from "./browser-audio-capture-source.js";
import { isMeetingTalkBackMode } from "./meeting-modes.js";
import type {
  MeetingBrowserStatusScriptParams,
  MeetingPlatformAdapterOptions,
} from "./platform-adapter-contract.js";
import type { MeetingPluginChromeHealth, MeetingTranscriptSnapshot } from "./session-types.js";

export function createMeetingBrowserAdapterOptions<
  Mode extends string,
  Health extends MeetingPluginChromeHealth<string, string>,
  Transcript extends MeetingTranscriptSnapshot,
>(options: {
  displayName: string;
  transcriptDisplayName?: string;
  manualActionReasonPrefix: string;
  admissionReasons?: readonly string[];
  retryCaptions: boolean;
  unavailableMessage: string;
  origin(meetingUrl: string): string | undefined;
  scripts: {
    audioCapture: (params: MeetingBrowserAudioCaptureRequest) => string;
    status(
      params: Omit<MeetingBrowserStatusScriptParams<Mode>, "mode" | "url" | "meetingSessionId"> & {
        allowMicrophone: boolean;
        meetingSessionId?: string;
        meetingUrl: string;
      },
    ): string;
    leave: (params: {
      leaveInitiated: boolean;
      meetingSessionId: string;
      meetingUrl: string;
    }) => string;
    transcript(meetingUrl: string, meetingSessionId: string, finalize: boolean): string;
  };
  statusFields?: (parsed: Record<string, unknown>) => Partial<Health>;
}): Pick<MeetingPlatformAdapterOptions<never, Mode, Health, Transcript>, "browser" | "parsing"> {
  const { scripts, manualActionReasonPrefix: prefix } = options;
  const transcriptDisplayName = options.transcriptDisplayName ?? options.displayName;
  return {
    browser: {
      buildAudioCaptureScript: scripts.audioCapture,
      allowsMicrophone: isMeetingTalkBackMode,
      buildStatusJoinScript: (params) =>
        scripts.status({
          allowMicrophone: isMeetingTalkBackMode(params.mode),
          allowSessionAdoption: params.allowSessionAdoption,
          autoJoin: params.autoJoin,
          captureCaptions: params.captureCaptions,
          guestName: params.guestName,
          meetingSessionId: params.meetingSessionId || undefined,
          meetingUrl: params.url,
          readOnly: params.readOnly,
          waitForInCallMs: params.waitForInCallMs,
        }),
      shouldRetryJoinStatus: (health) =>
        health.inCall === true &&
        ((health.manualAction?.reason === `${prefix}-audio-choice-required` &&
          health.audioInputRouted === true &&
          health.audioOutputRouteRetryable === true) ||
          (options.retryCaptions &&
            health.manualAction === undefined &&
            health.captionCaptureRequested === true &&
            health.captioning !== true)),
      browserControlUnavailable: () => ({
        category: "browser-control-unavailable",
        reason: "browser-control-unavailable",
        message: options.unavailableMessage,
      }),
      buildLeaveScript: (meetingUrl) =>
        scripts.leave({ leaveInitiated: false, meetingSessionId: "", meetingUrl }),
      buildSessionLeaveScript: scripts.leave,
      captions: {
        // Durable notes observe every mode; MeetingSessionRuntime gates live visibility.
        enabled: () => true,
        buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
          scripts.transcript(meetingUrl, meetingSessionId, finalize),
      },
      permissions: ({ allowMicrophone, meetingUrl }) => {
        const origin = options.origin(meetingUrl);
        return allowMicrophone && origin
          ? { origin, permissions: ["audioCapture"], optionalPermissions: ["speakerSelection"] }
          : undefined;
      },
    },
    parsing: {
      classifyManualActionReason: (reason) => {
        if (reason === "browser-control-unavailable") {
          return reason;
        }
        if (options.admissionReasons?.includes(reason)) {
          return "admission-required";
        }
        return (
          (
            [
              "login-required",
              "admission-required",
              "permission-required",
              "audio-choice-required",
              "session-conflict",
            ] as const
          ).find((category) => reason === `${prefix}-${category}`) ?? "custom"
        );
      },
      displayName: options.displayName,
      invalidTranscriptMessage: `${transcriptDisplayName} transcript payload is invalid.`,
      malformedStatusMessage: `${transcriptDisplayName} browser status JSON is malformed.`,
      malformedTranscriptMessage: `${transcriptDisplayName} transcript JSON is malformed.`,
      ...(options.statusFields ? { statusFields: options.statusFields } : {}),
    },
  };
}
