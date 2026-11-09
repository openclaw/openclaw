import type { TranscriptSessionSummary } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { isTranscriptSessionActive, readTranscriptCaptureSnapshot } from "./capture.js";
import type { projectTranscriptSession } from "./read.js";

/** Stored facts carry no live capture or provider authority across the worker boundary. */
export function presentTranscriptSession(
  session: ReturnType<typeof projectTranscriptSession>,
  captures = readTranscriptCaptureSnapshot(),
  providerName?: string,
): TranscriptSessionSummary {
  return {
    ...session,
    active: isTranscriptSessionActive(session),
    providerName,
    activeSubscription: captures.some(
      (capture) =>
        capture.state === "armed" &&
        capture.session.sessionId === session.sessionId &&
        capture.session.startedAt === session.startedAt,
    ),
  };
}
