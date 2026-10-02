import type { WorkerTaskControl } from "../../infra/worker-task-native-sections.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import type { SessionTranscriptHydrationWorkerRequest } from "./session-transcript-hydration.types.js";
import type { SessionTranscriptWorkerValues } from "./session-transcript-worker.types.js";

/** Read each hydrated view under the same worker-owned quarantine and snapshot admission. */
export async function readSessionTranscriptHydrationRequest(
  request: SessionTranscriptHydrationWorkerRequest,
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptWorkerValues[SessionTranscriptHydrationWorkerRequest["kind"]]> {
  const { readOpenClawDatabaseQuarantineFailure } =
    await import("../../state/openclaw-quarantine-store.js");
  const quarantine = readOpenClawDatabaseQuarantineFailure("agent", request.database.path, {
    env: request.target.env,
  });
  if (quarantine) {
    throw quarantine;
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
    return {
      kind: "bounded" as const,
      snapshot: readSessionTranscriptBoundedActiveContextCore(request.target, {
        ...request.limits,
        readOnly: true,
        resolvedScope: request.resolvedScope,
      }),
    };
  }
  if (!channel) {
    throw new Error("Full transcript hydration requires its host channel");
  }
  return streamSessionTranscriptHydration(request, channel, control);
}
