import type { SessionTranscriptWorkerRequest } from "../config/sessions/session-transcript-worker.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { readSessionProgressCard, readSessionProgressWork } from "./progress-card-store.js";

/** Display and semantic work reads share the transcript worker's admitted database. */
export function readProgressInWorker(
  request: Extract<
    SessionTranscriptWorkerRequest,
    { kind: "session-progress-card" | "session-progress-work" }
  >,
) {
  const options = { ...request.database, env: request.env };
  if (request.kind === "session-progress-work") {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readSessionProgressWork(database.db, request.owner),
      options,
    );
    if (!result.found) {
      throw new Error("Retained work physical owner is unavailable");
    }
    return { kind: "session-progress-work" as const, work: result.value };
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionProgressCard(database.db, request.sessionKey),
    options,
  );
  return { kind: "session-progress-card" as const, card: result.found ? result.value : null };
}
