/** Private bundled seam for lifecycle-owned meeting probe freshness. */

import {
  getMeetingSessionRuntimeProbeAccess,
  type MeetingBrowserHealthRefreshOutcome,
  type MeetingSessionProbeJoinResult,
} from "../meeting-bot/session-runtime-probes.js";

export type { MeetingBrowserHealthRefreshOutcome, MeetingSessionProbeJoinResult };

export function joinMeetingSessionForProbe<TSession, TRequest>(
  runtime: object,
  request: TRequest,
): Promise<MeetingSessionProbeJoinResult<TSession>> {
  return getMeetingSessionRuntimeProbeAccess<TSession, TRequest>(runtime).joinForProbe(request);
}

export function refreshMeetingCaptionHealthForProbe<TSession>(
  runtime: object,
  session: TSession,
): Promise<MeetingBrowserHealthRefreshOutcome> {
  return getMeetingSessionRuntimeProbeAccess<TSession, unknown>(
    runtime,
  ).refreshCaptionHealthForProbe(session);
}
