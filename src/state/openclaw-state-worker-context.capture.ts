import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { getGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateSchemaReadAdmission } from "./openclaw-state-db-schema-policy.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** Capture read authority without constructing a worker environment. */
export function captureOpenClawStateReadContextWithAdmission(
  pathname: string,
  captureAdmission: (pathname: string) => OpenClawStateWorkerContext["admission"],
  knownIdentity: (pathname: string) => DatabasePathIdentity | undefined,
): Pick<
  OpenClawStateWorkerContext,
  | "admission"
  | "maintenanceScope"
  | "existingSchemaPath"
  | "gatewayServiceInstallation"
  | "runInCapturedSchemaScope"
  | "stateIntegrity"
  | "artifactPreservingReads"
> & { assertPublicationCurrent: () => void } {
  const schema = captureOpenClawStateSchemaReadAdmission(pathname);
  const capturedAdmission = captureAdmission(pathname);
  const installation = getGatewayServiceInstallation();
  const integrity = capturedAdmission.captureIntegrity?.();
  const assertPublicationCurrent = capturedAdmission.assertCurrent;
  let admission = capturedAdmission;
  let runInCapturedSchemaScope: OpenClawStateWorkerContext["runInCapturedSchemaScope"];
  if (schema) {
    const inCapturedScope = AsyncLocalStorage.snapshot();
    admission = {
      databasePath: capturedAdmission.databasePath,
      coordinationKey: capturedAdmission.coordinationKey,
      get identity() {
        return capturedAdmission.identity;
      },
      captureIntegrity: capturedAdmission.captureIntegrity,
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
    assertPublicationCurrent,
    existingSchemaPath: schema?.path,
    // The admission owner already knows aliases; warm capture does not read the filesystem.
    // Unrelated installations must not change policy on an actor with active work.
    gatewayServiceInstallation:
      installation &&
      knownIdentity(installation.databasePath)?.key === capturedAdmission.identity.key
        ? installation
        : undefined,
    stateIntegrity: integrity,
    runInCapturedSchemaScope,
    artifactPreservingReads: isArtifactPreservingStateRead("agent", pathname) || undefined,
  };
}

/** Read-only workers need resolved runtime facts, not the initialization environment. */
export function captureOpenClawStateReadWorkerContextWithAdmission(
  options: { path?: string; env?: NodeJS.ProcessEnv },
  captureAdmission: (pathname: string) => OpenClawStateWorkerContext["admission"],
  knownIdentity: (pathname: string) => DatabasePathIdentity | undefined,
): OpenClawStateWorkerContext {
  const source = options.env ?? process.env;
  const env = process.platform === "win32" ? cloneEnvWithPlatformSemantics(source) : source;
  const environment: OpenClawStateWorkerContext["environment"] = {
    OPENCLAW_STATE_DIR: resolveStateDir(env),
    ...(isGatewayExternallySupervised(env) ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
  return {
    ...captureOpenClawStateReadContextWithAdmission(
      options.path ?? resolveOpenClawStateSqlitePath(environment),
      captureAdmission,
      knownIdentity,
    ),
    environment,
  };
}

/** Capture host facts before asynchronous work, without opening SQLite. */
export function captureOpenClawStateWorkerContextWithAdmission(
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
    initializationAgentPaths?: readonly string[];
  },
  captureAdmission: (pathname: string) => OpenClawStateWorkerContext["admission"],
  knownIdentity: (pathname: string) => DatabasePathIdentity | undefined,
): OpenClawStateWorkerContext {
  const context = captureOpenClawStateReadWorkerContextWithAdmission(
    options,
    captureAdmission,
    knownIdentity,
  );
  return {
    ...context,
    initializationEnvironment: mergeProcessEnv([
      options.env ?? process.env,
      { OPENCLAW_STATE_DIR: undefined, OPENCLAW_SUPERVISOR_MODE: undefined },
      context.environment,
    ]),
    ...(options.initializationAgentPaths
      ? {
          initializationAgentPaths: options.initializationAgentPaths.map((agentPath) =>
            path.resolve(agentPath),
          ),
        }
      : {}),
  };
}
