import { captureOpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  captureOpenClawStateReadContextWithAdmission,
  captureOpenClawStateWorkerContextWithAdmission,
} from "./openclaw-state-worker-context.capture.js";

export function captureOpenClawStateReadContext(pathname = resolveOpenClawStateSqlitePath()) {
  return captureOpenClawStateReadContextWithAdmission(
    pathname,
    captureOpenClawStateDatabaseReadAdmission,
  );
}

export function captureOpenClawStateWorkerContext(
  options: Parameters<typeof captureOpenClawStateWorkerContextWithAdmission>[0] = {},
) {
  return captureOpenClawStateWorkerContextWithAdmission(
    options,
    captureOpenClawStateDatabaseReadAdmission,
  );
}
