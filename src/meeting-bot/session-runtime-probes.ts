import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingPluginJoinResult,
  MeetingPluginProbeHealth,
} from "./session-types.js";

export type MeetingBrowserHealthRefreshOutcome = {
  /** True when the current browser health was inspected and applied. */
  browserHealthChecked: boolean;
  /** Whether the resulting manual action is fresh enough to expose to the caller. */
  manualActionIsAuthoritative: boolean;
};

export type MeetingBrowserRecoveryFailure = {
  kind: "missing" | "error";
  message: string;
};

type MeetingBrowserRecoveryHealth = MeetingBrowserHealth &
  MeetingPluginProbeHealth & {
    audioInputActive?: boolean;
    audioInputRouted?: boolean;
    audioOutputRouted?: boolean;
    providerConnected?: boolean;
    realtimeReady?: boolean;
    status?: string;
    notes?: string[];
  };

type MeetingBrowserRecoverySession<THealth extends MeetingBrowserRecoveryHealth> = {
  browserLeft?: boolean;
  updatedAt: string;
  notes: string[];
  chrome?: {
    browserTab?: MeetingBrowserTab;
    health?: THealth;
  };
};

function appendRecoveryNote(notes: string[] | undefined, message: string): string[] {
  return [...(notes ?? []).filter((note) => note !== message), message];
}

export function recordNonAuthoritativeMeetingBrowserRecoveryFailure<
  THealth extends MeetingBrowserRecoveryHealth,
>(session: MeetingBrowserRecoverySession<THealth>, failure: MeetingBrowserRecoveryFailure): void {
  const chrome = session.chrome;
  if (!chrome) {
    return;
  }
  const { manualAction: _manualAction, ...previousHealth } = chrome.health ?? {};
  const notes = appendRecoveryNote(chrome.health?.notes, failure.message);
  if (failure.kind === "missing") {
    chrome.browserTab = undefined;
    session.browserLeft = true;
    chrome.health = {
      ...previousHealth,
      inCall: false,
      micMuted: undefined,
      captioning: false,
      audioInputActive: false,
      audioInputRouted: false,
      audioOutputActive: false,
      audioOutputRouted: false,
      providerConnected: false,
      realtimeReady: false,
      status: "browser-tab-missing",
      notes,
    } as THealth;
  } else {
    chrome.health = {
      ...previousHealth,
      status: "browser-control",
      notes,
    } as THealth;
  }
  session.notes = appendRecoveryNote(session.notes, failure.message);
  session.updatedAt = new Date().toISOString();
}

export function normalizeMeetingBrowserHealthRefreshOutcome(
  result: MeetingBrowserHealthRefreshOutcome | boolean | void,
): MeetingBrowserHealthRefreshOutcome {
  if (result !== null && typeof result === "object") {
    return result;
  }
  const browserHealthChecked = result === true;
  return {
    browserHealthChecked,
    manualActionIsAuthoritative: browserHealthChecked,
  };
}

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
  failure: MeetingBrowserRecoveryFailure,
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
