import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";

export function decodeSqliteSnapshotStagingError(payload: unknown): Error {
  const remote = new Error("SQLite snapshot staging failed");
  retainOpenClawStateWorkerErrorPayload(remote, payload);
  return hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
}
