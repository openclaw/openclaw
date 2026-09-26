import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { captureStateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  isStateDatabaseReadAdmissionInvalidatedError,
} from "./openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-cache.js";
import { captureOpenClawStateSchemaReadAdmission } from "./openclaw-state-db-schema-policy.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export type OpenClawStateReadContext = Pick<
  OpenClawStateWorkerContext,
  "admission" | "maintenanceScope" | "existingSchemaPath" | "runInCapturedSchemaScope"
>;

/** Capture read authority without constructing a worker environment. */
export function captureOpenClawStateReadContext(
  pathname = resolveOpenClawStateSqlitePath(),
): OpenClawStateReadContext {
  const schema = captureOpenClawStateSchemaReadAdmission(pathname);
  const capturedAdmission = captureOpenClawStateDatabaseReadAdmission(pathname);
  let admission = capturedAdmission;
  let runInCapturedSchemaScope: OpenClawStateWorkerContext["runInCapturedSchemaScope"];
  if (schema) {
    const inCapturedScope = AsyncLocalStorage.snapshot();
    admission = {
      databasePath: capturedAdmission.databasePath,
      get identity() {
        return capturedAdmission.identity;
      },
      assertCurrent() {
        capturedAdmission.assertCurrent();
        schema.assertCurrent();
      },
    };
    runInCapturedSchemaScope = (operation) =>
      inCapturedScope(() => {
        admission.assertCurrent();
        return operation();
      });
  }
  return {
    maintenanceScope: getOpenClawDatabaseMaintenanceScope(),
    admission,
    existingSchemaPath: schema?.path,
    runInCapturedSchemaScope,
  };
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

/** Capture host facts before asynchronous work, without opening SQLite. */
export function captureOpenClawStateWorkerContext(
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
    initializationAgentPaths?: readonly string[];
  } = {},
): OpenClawStateWorkerContext {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const environment: OpenClawStateWorkerContext["environment"] = {
    OPENCLAW_STATE_DIR: resolveStateDir(env),
    ...(isGatewayExternallySupervised(env) ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
  return {
    ...captureOpenClawStateReadContext(options.path ?? resolveOpenClawStateSqlitePath(environment)),
    environment,
    initializationEnvironment: mergeProcessEnv([
      env,
      { OPENCLAW_STATE_DIR: undefined, OPENCLAW_SUPERVISOR_MODE: undefined },
      environment,
    ]),
    ...(options.initializationAgentPaths
      ? {
          initializationAgentPaths: options.initializationAgentPaths.map((agentPath) =>
            path.resolve(agentPath),
          ),
        }
      : {}),
    coordinatorRuntime: captureStateDatabaseCoordinatorRuntime(),
  };
}
