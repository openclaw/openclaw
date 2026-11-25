import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { SqliteSnapshotDirectoryBusyError } from "./sqlite-lifecycle-errors.js";

export function decodeSqliteSnapshotStagingError(
  payload: OpenClawStateWorkerErrorPayload | undefined,
): Error {
  const remote = new Error("SQLite snapshot staging failed");
  // SAFETY: The bundled staging worker encodes this private native-resource failure.
  retainOpenClawStateWorkerErrorPayload(remote, payload as OpenClawStateWorkerErrorPayload);
  const error = hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
  return error.name === "SqliteSnapshotDirectoryBusyError"
    ? new SqliteSnapshotDirectoryBusyError(error.message, { cause: error.cause })
    : error;
}
