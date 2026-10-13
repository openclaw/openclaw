import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  captureOpenClawStateReadContextWithAdmission,
  captureOpenClawStateReadWorkerContextWithAdmission,
  captureOpenClawStateWorkerContextWithAdmission,
} from "./openclaw-state-worker-context.capture.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export type OpenClawStateReadContext = ReturnType<
  typeof captureOpenClawStateReadContextWithAdmission
>;

/** Capture read authority without constructing a worker environment. */
export function captureOpenClawStateReadContext(
  pathname = resolveOpenClawStateSqlitePath(),
): OpenClawStateReadContext {
  return captureOpenClawStateReadContextWithAdmission(
    pathname,
    captureOpenClawStateDatabaseReadAdmission,
  );
}

/** Read-only workers need resolved runtime facts, not the initialization environment. */
export function captureOpenClawStateReadWorkerContext(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): OpenClawStateWorkerContext {
  return captureOpenClawStateReadWorkerContextWithAdmission(
    options,
    captureOpenClawStateDatabaseReadAdmission,
  );
}

/** Resident readers retain their source and schema policy without re-admitting each publication. */
export function prepareOpenClawStateReadSource(input: { path: string; env?: NodeJS.ProcessEnv }) {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = { path: path.resolve(input.path), env };
  const inSourceContext = AsyncLocalStorage.snapshot();
  const original = captureOpenClawStateReadContext(options.path);
  let context = original;
  let worker: OpenClawStateWorkerContext | undefined;

  const refresh = () => {
    original.maintenanceScope?.assertAdmission();
    const identity = original.admission.identity;
    if (identity.key.startsWith("file:")) {
      assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
    } else {
      original.admission.assertCurrent();
    }
    const next = captureOpenClawStateReadContext(options.path);
    const source = original.admission.identity;
    if (
      next.admission.identity.key !== source.key ||
      next.admission.identity.birthtime !== source.birthtime ||
      next.maintenanceScope !== original.maintenanceScope ||
      next.existingSchemaPath !== original.existingSchemaPath
    ) {
      throw new Error("Prepared state read source changed before read admission");
    }
    return (context = next);
  };
  const current = () => {
    context.maintenanceScope?.assertAdmission();
    try {
      context.admission.assertCurrent();
      if (context.admission.identity.key.startsWith("file:")) {
        return context;
      }
    } catch (error) {
      if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
        throw error;
      }
    }
    return inSourceContext(refresh);
  };
  const prepareWorker = () => {
    // Actual reads verify the file even when no local publication revoked its admission.
    const next = refresh();
    worker ??= captureOpenClawStateWorkerContext(options);
    if (worker.admission !== next.admission) {
      worker = { ...worker, ...next };
    }
    return worker;
  };
  return {
    current,
    workerContext: () => inSourceContext(prepareWorker),
    withCurrent<T>(consume: (context: OpenClawStateWorkerContext) => T): T {
      return inSourceContext(() => consume(prepareWorker()));
    },
  };
}

export function captureOpenClawStateWorkerContext(
  options: Parameters<typeof captureOpenClawStateWorkerContextWithAdmission>[0] = {},
): OpenClawStateWorkerContext {
  return captureOpenClawStateWorkerContextWithAdmission(
    options,
    captureOpenClawStateDatabaseReadAdmission,
  );
}
