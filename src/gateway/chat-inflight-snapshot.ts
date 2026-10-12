import type { AgentEventPayload } from "../infra/agent-events.js";
import type { ChatRunPlanSnapshot, ChatRunState } from "./server-chat-state.js";

export type InFlightRunSnapshot = {
  runId: string;
  text: string;
  startedAt?: number;
  /**
   * True when the in-flight run is owned by the embedded-run registry and can
   * only be cancelled through the session-owned abort path (sessions.abort),
   * never through run-specific chat.abort. Control UI uses this to keep Stop
   * routing session-scoped for recovered embedded runs.
   */
  sessionAbortable?: boolean;
  plan?: ChatRunPlanSnapshot;
  events?: AgentEventPayload[];
};

export function projectInFlightRunSnapshot(params: {
  chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs">;
  runId: string;
  startedAtMs?: number;
  sessionAbortable?: boolean;
}): InFlightRunSnapshot {
  const run = params.chatRunState.runs.get(params.runId);
  const projected = params.chatRunState.resolveBuffer(params.runId);
  const plan = run?.planSnapshot;
  const events = run?.progressSnapshot?.events;
  return {
    runId: params.runId,
    text: projected.suppress ? "" : projected.text,
    ...(params.startedAtMs === undefined ? {} : { startedAt: params.startedAtMs }),
    ...(params.sessionAbortable ? { sessionAbortable: true } : {}),
    ...(plan ? { plan } : {}),
    ...(events?.length ? { events } : {}),
  };
}
