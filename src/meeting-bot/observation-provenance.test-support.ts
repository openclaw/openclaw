import { readMeetingTranscriptWithBrowser } from "./browser-session-control.js";
import { MeetingPlatformAdapter, type MeetingBrowserJoinSession } from "./platform-adapter.js";
import type {
  MeetingObservationProvenance,
  MeetingPluginProbeHealth,
  MeetingTranscriptLine,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

export const TEST_MEETING_URL = "https://meeting.example/room";
export const TEST_CAPTION_SOURCE: NonNullable<MeetingTranscriptLine["source"]> = {
  id: "caption-1",
  epoch: "epoch-1",
  revision: "2",
  finalized: true,
  ownEcho: false,
};

export function testMeetingObservation(
  overrides: Partial<MeetingObservationProvenance> = {},
): MeetingObservationProvenance {
  return {
    observer: "test-caption-dom",
    observationId: "session-1:epoch-1:observation:1",
    sessionId: "session-1",
    epoch: "epoch-1",
    observedAt: "2026-09-01T00:00:00.000Z",
    speaker: "Alice",
    self: "other",
    ...overrides,
  };
}

export const TEST_MEETING_PLATFORM_ADAPTER = MeetingPlatformAdapter.create<
  MeetingBrowserJoinSession<"agent">,
  "agent",
  MeetingPluginProbeHealth,
  MeetingTranscriptSnapshot
>({
  id: "test-meeting",
  displayName: "Test Meeting",
  browserLabel: "Test meeting",
  logScope: "[test-meeting]",
  nodeCommandName: "test.meeting",
  nodeConfigPath: "test.meeting.node",
  agentConsult: {
    surface: "a private test meeting",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    workingResponseLabel: "participant",
    extraSystemPrompt: "",
  },
  session: { idPrefix: "test", participantIdentity: () => "OpenClaw" },
  urls: {
    validateAndNormalize: (input) => String(input),
    normalizeForReuse: (url) => url,
    isSameMeeting: (left, right) => left === right,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: () => true,
    isRecoverableTab: () => true,
    localeAction: () => undefined,
  },
  browser: {
    allowsMicrophone: () => false,
    buildStatusJoinScript: () => "() => '{}'",
    buildLeaveScript: () => "() => '{}'",
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-unavailable",
      message: "Browser unavailable.",
    }),
    captions: { enabled: () => true, buildTranscriptScript: () => "() => '{}'" },
    permissions: () => undefined,
  },
  parsing: {
    classifyManualActionReason: () => "custom",
    displayName: "Test Meeting",
    invalidTranscriptMessage: "Invalid transcript payload",
    malformedStatusMessage: "Malformed status JSON",
    malformedTranscriptMessage: "Malformed transcript JSON",
  },
});

/** Exercise the real parser and browser return boundary, without starting a browser. */
export async function readTestMeetingTranscript(payload: unknown) {
  return await readMeetingTranscriptWithBrowser({
    adapter: TEST_MEETING_PLATFORM_ADAPTER,
    callBrowser: async () => ({ result: JSON.stringify(payload) }),
    finalize: false,
    meetingUrl: TEST_MEETING_URL,
    meetingSessionId: "session-1",
    tab: { targetId: "tracked-tab", openedByPlugin: false },
    timeoutMs: 1_000,
  });
}
