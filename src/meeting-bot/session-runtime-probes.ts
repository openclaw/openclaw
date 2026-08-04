import type { MeetingPluginJoinResult } from "./session-types.js";

export type MeetingBrowserHealthRefreshOutcome = {
  /** True when the current browser health was inspected and applied. */
  browserHealthChecked: boolean;
  /** Whether the resulting manual action is fresh enough to expose to the caller. */
  manualActionIsAuthoritative: boolean;
};

export type MeetingSessionProbeJoinResult<TSession> = MeetingPluginJoinResult<TSession> &
  MeetingBrowserHealthRefreshOutcome;

type MeetingSessionRuntimeProbeAccess<TSession, TRequest> = {
  joinForProbe(request: TRequest): Promise<MeetingSessionProbeJoinResult<TSession>>;
  refreshCaptionHealthForProbe(session: TSession): Promise<MeetingBrowserHealthRefreshOutcome>;
};

const runtimeProbeAccess = new WeakMap<object, unknown>();

export function registerMeetingSessionRuntimeProbeAccess<TSession, TRequest>(
  runtime: object,
  access: MeetingSessionRuntimeProbeAccess<TSession, TRequest>,
): void {
  runtimeProbeAccess.set(runtime, access);
}

export function getMeetingSessionRuntimeProbeAccess<TSession, TRequest>(
  runtime: object,
): MeetingSessionRuntimeProbeAccess<TSession, TRequest> {
  const access = runtimeProbeAccess.get(runtime);
  if (!access) {
    throw new Error("Meeting session runtime probe access is unavailable.");
  }
  return access as MeetingSessionRuntimeProbeAccess<TSession, TRequest>;
}
