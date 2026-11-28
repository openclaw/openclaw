import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import { TRAJECTORY_RUNTIME_FILE_MAX_BYTES } from "./paths.js";
import { restoreTrajectorySnapshots } from "./runtime-snapshot.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";

/** Read the bounded runtime source and restore logical events before public redaction. */
export async function loadTrajectoryRuntimeForExport(
  marker: Pick<SessionTranscriptRuntimeTarget, "agentId" | "sessionId" | "storePath"> | undefined,
  maxEventCount: number,
) {
  if (!marker) {
    return [];
  }
  return restoreTrajectorySnapshots(
    await loadSqliteTrajectoryRuntimeEvents({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
      maxEventBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
      maxEventCount,
    }),
  );
}
