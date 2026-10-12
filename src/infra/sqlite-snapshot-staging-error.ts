import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";

export function decodeSqliteSnapshotStagingError(payload: unknown): Error {
  const remote = new Error("SQLite snapshot staging failed");
  // SAFETY: The bundled staging worker encodes this private native-resource failure.
  retainOpenClawStateWorkerErrorPayload(remote, payload as OpenClawStateWorkerErrorPayload);
  return hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
}
