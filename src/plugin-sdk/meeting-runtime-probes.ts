/** Private bundled seam for lifecycle-owned meeting probe freshness. */

import {
  getMeetingSessionRuntimeProbeAccess,
  recordNonAuthoritativeMeetingBrowserRecoveryFailure,
  registerMeetingSessionRuntimeHealthRefresh,
  type MeetingBrowserHealthRefreshOutcome,
  type MeetingBrowserRecoveryFailure,
  type MeetingSessionProbeJoinResult,
} from "../meeting-bot/session-runtime-probes.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingPluginProbeHealth,
} from "../meeting-bot/session-types.js";

export type {
  MeetingBrowserHealthRefreshOutcome,
  MeetingBrowserRecoveryFailure,
  MeetingSessionProbeJoinResult,
};

type MeetingSessionJoinRuntimeForProbe<TSession, TRequest> = {
  join(request: TRequest): Promise<{ session: TSession }>;
};

type MeetingSessionHealthRuntimeForProbe<TSession> = {
  refreshBrowserHealth(
    session: TSession,
    options?: { force?: boolean; readOnly?: boolean; timeoutMs?: number; deadline?: number },
  ): Promise<void>;
  refreshCaptionHealth(session: TSession): Promise<void>;
};

type MeetingBrowserRecoveryHealthForProbe = MeetingBrowserHealth &
  MeetingPluginProbeHealth & {
    audioInputActive?: boolean;
    audioInputRouted?: boolean;
    audioOutputRouted?: boolean;
    providerConnected?: boolean;
    realtimeReady?: boolean;
    status?: string;
    notes?: string[];
  };

type MeetingBrowserRecoverySessionForProbe<THealth extends MeetingBrowserRecoveryHealthForProbe> = {
  browserLeft?: boolean;
  updatedAt: string;
  notes: string[];
  chrome?: {
    browserTab?: MeetingBrowserTab;
    health?: THealth;
  };
};

export function recordNonAuthoritativeMeetingBrowserRecoveryFailureForProbe<
  THealth extends MeetingBrowserRecoveryHealthForProbe,
>(
  session: MeetingBrowserRecoverySessionForProbe<THealth>,
  failure: MeetingBrowserRecoveryFailure,
): void {
  recordNonAuthoritativeMeetingBrowserRecoveryFailure(session, failure);
}

export function joinMeetingSessionForProbe<TSession, TRequest>(
  runtime: MeetingSessionJoinRuntimeForProbe<TSession, TRequest>,
  request: TRequest,
): Promise<MeetingSessionProbeJoinResult<TSession>> {
  return getMeetingSessionRuntimeProbeAccess<TSession, TRequest>(runtime).joinForProbe(request);
}

export function refreshMeetingCaptionHealthForProbe<TSession>(
  runtime: MeetingSessionHealthRuntimeForProbe<TSession>,
  session: TSession,
  deadline?: number,
): Promise<MeetingBrowserHealthRefreshOutcome> {
  return getMeetingSessionRuntimeProbeAccess<TSession, unknown>(
    runtime,
  ).refreshCaptionHealthForProbe(session, deadline);
}

export function registerMeetingSessionRuntimeHealthRefreshForProbe<TSession>(
  runtime: MeetingSessionHealthRuntimeForProbe<TSession>,
  refresh: (
    session: TSession,
    options?: { force?: boolean; readOnly?: boolean; timeoutMs?: number; deadline?: number },
  ) => Promise<MeetingBrowserHealthRefreshOutcome>,
): void {
  registerMeetingSessionRuntimeHealthRefresh(runtime, refresh);
}
