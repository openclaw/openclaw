import { captureOpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  captureOpenClawStateReadContext as captureReadContext,
  captureOpenClawStateWorkerContext as captureWorkerContext,
} from "./openclaw-state-worker-context.capture.js";

export function captureOpenClawStateReadContext(pathname = resolveOpenClawStateSqlitePath()) {
  return captureReadContext(pathname, captureOpenClawStateDatabaseReadAdmission);
}

export function captureOpenClawStateWorkerContext(
  options: Parameters<typeof captureWorkerContext>[0] = {},
) {
  return captureWorkerContext(options, captureOpenClawStateDatabaseReadAdmission);
}
