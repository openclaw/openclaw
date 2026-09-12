import { describeRunningOpenClawBuild } from "../infra/sqlite-user-version.js";
import type {
  DeferredStateSchemaPublication,
  IncompatibleOpenClawDatabase,
  IndeterminateOpenClawDatabase,
  OpenClawDatabaseSchemaPreflightOperation,
} from "./openclaw-database-preflight.types.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "./openclaw-state-db-contract.js";
import type { StateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";

function formatDoctorIncompatibleDatabase(database: IncompatibleOpenClawDatabase): string {
  const agent = database.agentId ? ` for agent ${database.agentId}` : "";
  const writer = database.writerAppVersion ? `; writer build ${database.writerAppVersion}` : "";
  return `${database.kind} database${agent} ${database.path} uses schema ${database.foundVersion}; this build supports ${database.supportedVersion}${writer}.`;
}

export function formatIncompatibleDatabaseSchemas(
  incompatibleDatabases: readonly IncompatibleOpenClawDatabase[],
  operation: OpenClawDatabaseSchemaPreflightOperation,
): string {
  const prefix =
    operation === "doctor"
      ? "Doctor refused to continue"
      : operation === "gateway-restart"
        ? "Gateway refused restart"
        : "Gateway refused startup";
  const doctorGuidance =
    operation === "doctor"
      ? ` ${incompatibleDatabases.map(formatDoctorIncompatibleDatabase).join(" ")} Run Doctor with the OpenClaw install that wrote this state (typically the active Gateway install), or another build that supports these schemas.`
      : "";
  return (
    `${prefix} because ${incompatibleDatabases.length} OpenClaw database schema(s) are newer than this build. ` +
    `Refused by ${describeRunningOpenClawBuild()}.${doctorGuidance} See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`
  );
}

export function formatIndeterminateDatabaseReadiness(
  indeterminate: readonly IndeterminateOpenClawDatabase[],
  operation: OpenClawDatabaseSchemaPreflightOperation,
): string {
  const shown = indeterminate
    .slice(0, 3)
    .map((database) => `${database.kind} ${database.path}: ${database.reason}`);
  const omitted = indeterminate.length - shown.length;
  const action =
    operation === "doctor"
      ? "Doctor could not complete repair"
      : operation === "gateway-startup"
        ? "Gateway refused startup"
        : "Gateway refused restart";
  return `${action} because persisted database readiness could not be verified: ${shown.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}. ${operation === "doctor" ? "Stop OpenClaw processes, then restore the affected database from a verified backup." : "Stop the Gateway and other OpenClaw processes, run openclaw doctor --fix, then retry."}`;
}

export function describeDeferredStateSchemaPublication(
  blocker: StateSchemaPublicationBlocker | undefined,
  databasePath: string,
  foundVersion: number,
  contentVersion: number,
): DeferredStateSchemaPublication {
  return {
    kind: "state",
    path: databasePath,
    foundVersion,
    contentVersion,
    ...(blocker ? { runId: blocker.runId, publishAfterMs: blocker.publishAfterMs } : {}),
    message: blocker
      ? `Schema content applied; version publication deferred until update run ${blocker.runId} finishes and its five-minute grace expires (or the running driver is abandoned for 30 minutes).`
      : "Schema content applied; version publication will complete on the next writable database open.",
  };
}
