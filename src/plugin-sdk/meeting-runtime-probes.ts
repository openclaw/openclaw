/** Private bundled seam for lifecycle-owned meeting probe freshness. */

import {
  getMeetingSessionRuntimeProbeAccess,
  registerMeetingSessionRuntimeHealthRefresh,
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

export function registerMeetingSessionRuntimeHealthRefreshForProbe<TSession>(
  runtime: object,
  refresh: (
    session: TSession,
    options?: { force?: boolean; readOnly?: boolean },
  ) => Promise<MeetingBrowserHealthRefreshOutcome>,
): void {
  registerMeetingSessionRuntimeHealthRefresh(runtime, refresh);
}
