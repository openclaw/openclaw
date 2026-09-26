import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import type { MeetingObservationProvenance } from "./session-types.js";

export type MeetingParticipationAction = { type: string; [key: string]: unknown };
export type MeetingParticipationRequest = {
  requestId: string;
  sourceId?: string;
  correctionOf?: string;
  action: MeetingParticipationAction;
};
export type MeetingParticipationEffectResult = {
  status: "succeeded" | "failed" | "uncertain" | "unsupported" | "rejected";
  message?: string;
  observed?: Record<string, unknown>;
  /** Only rejected results that prove the requested effect did not occur may request correction. */
  correctable?: true;
};
export type MeetingParticipationResult = MeetingParticipationEffectResult & {
  requestId: string;
  replayed?: boolean;
  /** One correction of this request is permitted; it retains the original source and action type. */
  correctionOf?: string;
};
/** Provider-observed identity. Never accept this object from model/tool arguments. */
export type MeetingParticipationSource = {
  id: string;
  epoch: string;
  revision: string;
  kind: "chat" | "caption";
  text: string;
  /** Observation that supplied this source; does not refresh its age, order, or authority. */
  provenance?: MeetingObservationProvenance;
  ownEcho?: boolean;
  finalized: boolean;
};
export type MeetingParticipationContext = {
  sessionId: string;
  active: boolean;
  /** Includes first observations of interim sources, which cannot themselves authorize actions. */
  sourceOrder: number;
  capabilities: readonly string[];
  sources: Array<
    MeetingParticipationSource & { sourceId: string; order: number; replacesSourceId?: string }
  >;
};
export type MeetingParticipationAttempt = {
  kind: "meeting-participation-attempt";
  sessionId: string;
  requestId: string;
  fingerprint: string;
  sourceId?: string;
  actionType: string;
  correctionOf?: string;
  result?: MeetingParticipationResult;
};
type MeetingParticipationStore = Pick<
  PluginStateKeyedStore<MeetingParticipationAttempt>,
  "lookup" | "registerIfAbsent" | "register" | "entries" | "delete"
>;
export type MeetingBrowserParticipationAdapter = {
  capabilities: readonly string[];
  validateAction(action: MeetingParticipationAction): string | undefined;
  /** Preparation may await UI readiness but must never perform the requested external action. */
  buildPreparationScript?(params: {
    meetingSessionId: string;
    meetingUrl: string;
    requestId: string;
    action: MeetingParticipationAction;
  }): string;
  parsePreparationResult?(
    result: unknown,
    action: MeetingParticipationAction,
  ): MeetingParticipationEffectResult;
  /** Verify page session/URL and perform the effect synchronously before any await. */
  buildActionScript(params: {
    meetingSessionId: string;
    meetingUrl: string;
    requestId: string;
    action: MeetingParticipationAction;
  }): string;
  parseActionResult(
    result: unknown,
    action: MeetingParticipationAction,
  ): MeetingParticipationEffectResult;
};
export type MeetingParticipationOptions<TSession> = {
  store: MeetingParticipationStore;
  capabilities(session: TSession): readonly string[];
  validateAction(action: MeetingParticipationAction): string | undefined;
  execute(
    session: TSession,
    request: MeetingParticipationRequest,
    assertCurrent: () => void,
  ): Promise<MeetingParticipationEffectResult>;
};
