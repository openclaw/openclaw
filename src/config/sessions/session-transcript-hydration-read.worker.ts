import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import type { SessionTranscriptHydrationWorkerRequest } from "./session-transcript-hydration.types.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

/** Read each hydrated view under the same worker-owned quarantine and snapshot admission. */
export async function readSessionTranscriptHydrationRequest(
  request: SessionTranscriptHydrationWorkerRequest,
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptWorkerValues[SessionTranscriptHydrationWorkerRequest["kind"]]> {
  if (request.kind === "transcript-maintenance") {
    const { withOpenClawAgentDatabaseReadOnly } =
      await import("../../state/openclaw-agent-db-readonly.js");
    const { readSessionTranscriptMaintenance } =
      await import("./session-transcript-maintenance-read.js");
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readSessionTranscriptMaintenance(database, request.target, request.request),
      { ...request.database, env: request.target.env },
    );
    if (!result.found) {
      throw new Error("Session transcript is unavailable for maintenance planning");
    }
    return result.value;
  }
  if (request.kind === "latest-active-message") {
    const { readLatestSessionTranscriptMessageEvent } =
      await import("./session-accessor.sqlite-active-events.js");
    return {
      kind: "latest-active-message",
      message: readLatestSessionTranscriptMessageEvent(request.target, {
        readOnly: true,
        resolvedScope: request.resolvedScope,
      }),
    };
  }
  if (request.kind === "recent-active-events") {
    const { readRecentSessionTranscriptActiveEvents } =
      await import("./session-accessor.sqlite-active-events.js");
    return {
      kind: "recent-active-events",
      events: readRecentSessionTranscriptActiveEvents(request.target, request.maxEvents, {
        readOnly: true,
        resolvedScope: request.resolvedScope,
      }),
    };
  }
  if (request.kind === "current-turn-entry") {
    const { readSessionTranscriptCurrentTurnEntry } =
      await import("./session-accessor.sqlite-current-turn.js");
    return readSessionTranscriptCurrentTurnEntry(request.target, {
      entryId: request.entryId,
      version: request.version,
      includeEntry: request.includeEntry,
      readOnly: true,
      resolvedScope: request.resolvedScope,
    });
  }
  const { readSessionTranscriptBoundedActiveContextCore } =
    await import("./session-accessor.sqlite-active-context.js");
  const { streamSessionTranscriptHydration } =
    await import("./session-transcript-hydration.worker.js");
  if (request.limits) {
    const selection = request.transcript;
    if (
      selection &&
      (selection.sessionKey !== request.resolvedScope.sessionKey ||
        selection.entryIds.length > MAX_SESSION_ROW_FACTS_KEYS)
    ) {
      throw new Error("Transcript hydration cohort must select its own bounded session");
    }
    const { readSessionTranscriptAnchorFactsInDatabase } =
      await import("./session-transcript-anchor-read.kernel.js");
    const { assertOpenClawAgentDatabaseIdentity } =
      await import("../../state/openclaw-agent-db-identity.js");
    let transcript: Extract<
      SessionTranscriptWorkerValues["transcript-hydration"],
      { kind: "bounded" }
    >["transcript"];
    const snapshot = readSessionTranscriptBoundedActiveContextCore(request.target, {
      ...request.limits,
      readOnly: true,
      resolvedScope: request.resolvedScope,
      onRead: (projection) => {
        const { database, resolved } = projection;
        if (request.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
        }
        if (selection) {
          transcript = readSessionTranscriptAnchorFactsInDatabase(
            database,
            { ...resolved, sessionKey: selection.sessionKey },
            selection,
            undefined,
            projection,
          );
        }
      },
    });
    return {
      kind: "bounded" as const,
      snapshot,
      ...(selection ? { transcript } : {}),
    };
  }
  if (!channel) {
    throw new Error("Full transcript hydration requires its host channel");
  }
  return streamSessionTranscriptHydration(request, channel, control);
}
