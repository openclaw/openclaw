import type { DatabaseSync } from "node:sqlite";
import { agentDatabaseLifecycle } from "../state/openclaw-agent-db-lifecycle.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { hasPendingCurrentVersionAgentDatabaseMigration } from "../state/openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import {
  hasOpenClawDatabaseQuarantineRecord,
  readOpenClawDatabaseQuarantineFailure,
} from "../state/openclaw-quarantine-store.js";
import { isTruthyEnvValue } from "./env.js";

/**
 * Doctor may skip an unchanged current-schema database during an update.
 * A persisted quarantine row must stay in the migration so it can be cleared
 * after integrity; short-circuit order matches the previous inline checks.
 */
export function shouldDeferUnchangedAgentDatabase(params: {
  agentId: string;
  database: DatabaseSync;
  env: NodeJS.ProcessEnv;
  pathname: string;
  userVersion: number;
}): boolean {
  return (
    isTruthyEnvValue(params.env.OPENCLAW_UPDATE_IN_PROGRESS) &&
    params.userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
    !hasPendingCurrentVersionAgentDatabaseMigration(params.database) &&
    !agentDatabaseLifecycle.terminal.peek(params.pathname) &&
    !hasOpenClawDatabaseQuarantineRecord(params.pathname, { env: params.env }) &&
    !readOpenClawDatabaseQuarantineFailure("agent", params.pathname, {
      env: params.env,
      fresh: true,
    }) &&
    !assertOpenClawAgentDatabaseForMaintenance(params.database, {
      agentId: params.agentId,
      pathname: params.pathname,
      allowStartupIndexRepair: true,
    })
  );
}

/**
 * Clear the open-failure record after schema preparation when integrity
 * changed, the lifecycle is terminal, or a quarantine row still exists.
 * The failure read stays last so a definite mismatch is not hashed first.
 */
export function shouldClearAgentDatabaseOpenFailure(params: {
  env: NodeJS.ProcessEnv;
  hasIntegrityChanges: boolean;
  pathname: string;
}): boolean {
  return (
    params.hasIntegrityChanges ||
    agentDatabaseLifecycle.terminal.peek(params.pathname) !== undefined ||
    hasOpenClawDatabaseQuarantineRecord(params.pathname, { env: params.env }) ||
    readOpenClawDatabaseQuarantineFailure("agent", params.pathname, {
      env: params.env,
      fresh: true,
    }) !== undefined
  );
}
