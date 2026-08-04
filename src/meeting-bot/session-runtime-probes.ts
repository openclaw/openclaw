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

type MeetingSessionRuntimeHealthRefresh<TSession> = (
  session: TSession,
  options?: { force?: boolean; readOnly?: boolean },
) => Promise<MeetingBrowserHealthRefreshOutcome>;

type MeetingSessionRuntimeRecoveryFailure<TSession> = (
  session: TSession,
  failure: { kind: "missing" | "error"; message: string },
) => "authoritative" | void;

const runtimeProbeAccess = new WeakMap<object, unknown>();
const runtimeHealthRefreshAccess = new WeakMap<object, unknown>();
const runtimeRecoveryFailureAccess = new WeakMap<object, unknown>();

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

export function registerMeetingSessionRuntimeHealthRefresh<TSession>(
  runtime: object,
  refresh: MeetingSessionRuntimeHealthRefresh<TSession>,
): void {
  runtimeHealthRefreshAccess.set(runtime, refresh);
}

export function getMeetingSessionRuntimeHealthRefresh<TSession>(
  runtime: object,
): MeetingSessionRuntimeHealthRefresh<TSession> | undefined {
  return runtimeHealthRefreshAccess.get(runtime) as
    | MeetingSessionRuntimeHealthRefresh<TSession>
    | undefined;
}

export function registerMeetingSessionRuntimeRecoveryFailure<TSession>(
  runtime: object,
  record: MeetingSessionRuntimeRecoveryFailure<TSession>,
): void {
  runtimeRecoveryFailureAccess.set(runtime, record);
}

export function getMeetingSessionRuntimeRecoveryFailure<TSession>(
  runtime: object,
): MeetingSessionRuntimeRecoveryFailure<TSession> | undefined {
  return runtimeRecoveryFailureAccess.get(runtime) as
    | MeetingSessionRuntimeRecoveryFailure<TSession>
    | undefined;
}
