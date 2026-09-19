import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawRegisteredAgentDatabase,
} from "./openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseRegistrationCommit } from "./openclaw-agent-db-registry.js";
import {
  isStateDatabaseReadAdmissionInvalidatedError,
  type OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { detectOpenClawStateDatabaseSchemaMigrationsFromDatabase } from "./openclaw-state-db-schema-repair.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

// Registry metadata is process-stable: registry writes invalidate after each commit;
// other-process changes take effect on restart. Polling here puts schema probes back on hot reads.
type AgentDatabaseRegistryMemo = {
  pathname: string;
  token: symbol;
  entries?: readonly OpenClawRegisteredAgentDatabase[];
};
// A plugin may first open a hot-created agent; its registration must invalidate
// native discovery even when subsequent callers reuse the shared connection.
const registry = resolveGlobalSingleton<{ memo?: AgentDatabaseRegistryMemo }>(
  Symbol.for("openclaw.agentDatabaseRegistryMemo"),
  () => ({}),
);

function resolveAgentDatabaseRegistryPath(options: OpenClawStateDatabaseOptions): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

function activateRegisteredAgentDatabasesMemo(
  options: OpenClawStateDatabaseOptions,
): AgentDatabaseRegistryMemo {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registry.memo?.pathname !== pathname) {
    // One active pathname keeps registry metadata process-stable without retaining
    // an unbounded generation map. Switching back creates a fresh generation.
    registry.memo = { pathname, token: Symbol(pathname) };
  }
  return registry.memo;
}

/** Return the process-stable generation for the active agent database registry. */
export function readOpenClawAgentDatabaseRegistryToken(
  options: OpenClawStateDatabaseOptions = {},
): symbol {
  return activateRegisteredAgentDatabasesMemo(options).token;
}

export function invalidateRegisteredAgentDatabasesMemo(
  options: OpenClawStateDatabaseOptions,
): void {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registry.memo?.pathname === pathname) {
    registry.memo = { pathname, token: Symbol(pathname) };
  }
}

/** Publish only registration witnessed at COMMIT, under its original shared generation. */
export function captureOpenClawAgentDatabaseRegistration(params: {
  agentId: string;
  agentPath: string;
  admission: OpenClawStateDatabaseReadAdmission;
}) {
  const options = { path: params.admission.databasePath };
  let active = false;
  let committed = false;
  let finished = false;
  return {
    begin() {
      if (finished) {
        throw new Error("Agent database registration admission is closed");
      }
      if (!active) {
        active = true;
        invalidateRegisteredAgentDatabasesMemo(options);
      }
    },
    recordCommitted(receipt: OpenClawAgentDatabaseRegistrationCommit) {
      if (
        finished ||
        !active ||
        receipt.agentId !== params.agentId ||
        receipt.agentPath !== params.agentPath ||
        receipt.stateDatabasePath !== params.admission.databasePath ||
        receipt.stateDatabaseIdentity !== params.admission.identity.key
      ) {
        throw new Error("Agent registration commit differs from its captured owner");
      }
      committed = true;
    },
    finish() {
      if (finished) {
        return;
      }
      finished = true;
      try {
        params.admission.assertCurrent();
      } catch (error) {
        if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
          return;
        }
        throw error;
      }
      if (active) {
        invalidateRegisteredAgentDatabasesMemo(options);
      }
      if (committed) {
        sessionChanges.emit({ all: true, scope: "stores" });
      }
    },
  };
}

function cloneRegisteredAgentDatabases(
  entries: readonly OpenClawRegisteredAgentDatabase[],
): OpenClawRegisteredAgentDatabase[] {
  return entries.map((entry) => ({ ...entry }));
}

function hasUnavailableMissingSqlitePath(pathname: string): boolean {
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
  }

  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return !stat.isDirectory();
      }
      try {
        return !statSync(ancestor).isDirectory();
      } catch {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

type AgentDatabaseRegistryListOptions = OpenClawStateDatabaseOptions & {
  includeIncompatibleSchemaVersions?: boolean;
};

/** Read durable registrations from an already opened live or captured database. */
export function readOpenClawAgentDatabaseRegistryRows(database: DatabaseSync, pathname: string) {
  const registryTable = database
    .prepare("SELECT type FROM sqlite_master WHERE name = 'agent_databases'")
    .get() as { type?: unknown } | undefined;
  if (!registryTable) {
    return [];
  }
  if (registryTable.type !== "table") {
    throw new Error(`OpenClaw state database ${pathname} has an invalid agent registry.`);
  }
  const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_databases").selectAll().orderBy("agent_id", "asc").orderBy("path", "asc"),
  ).rows;
}

export function readAgentDatabasePreflightTargets(database: DatabaseSync, registryPath: string) {
  return readOpenClawAgentDatabaseRegistryRows(database, registryPath).flatMap((row) =>
    typeof row.agent_id === "string" && typeof row.path === "string"
      ? [
          {
            agentId: row.agent_id,
            path: resolveOpenClawRegisteredAgentDatabasePath(registryPath, row.path),
          },
        ]
      : [],
  );
}

export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: false,
): OpenClawRegisteredAgentDatabase[];
export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: true,
): Promise<OpenClawRegisteredAgentDatabase[]>;
export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: boolean,
): OpenClawRegisteredAgentDatabase[] | Promise<OpenClawRegisteredAgentDatabase[]> {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  const read = ({ db: database }: { db: import("node:sqlite").DatabaseSync }) => {
    const schemaMigrations = detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(
      database,
      pathname,
    );
    if (!artifactPreserving && schemaMigrations.length > 0) {
      throw new Error(
        `OpenClaw state database ${pathname} has a legacy agent database registry schema; run openclaw doctor --fix to migrate it.`,
      );
    }
    return readOpenClawAgentDatabaseRegistryRows(database, pathname).map((row) => ({
      agentId: normalizeAgentId(row.agent_id),
      path: resolveOpenClawRegisteredAgentDatabasePath(pathname, row.path),
      schemaVersion: row.schema_version,
      lastSeenAt: row.last_seen_at,
      sizeBytes: row.size_bytes,
    }));
  };
  const finish = (entries: OpenClawRegisteredAgentDatabase[] | undefined) => {
    if (entries === undefined) {
      if (hasUnavailableMissingSqlitePath(pathname)) {
        throw new Error(`OpenClaw state database ${pathname} is unavailable.`);
      }
      return [];
    }
    return options.includeIncompatibleSchemaVersions
      ? entries
      : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
  };
  return artifactPreserving
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(read, options).then(finish)
    : finish(withExistingOpenClawStateDatabaseReadOnly(read, options));
}

/** Inspect a copied registry without creating SQLite artifacts or runtime memo state. */
export async function inspectOpenClawRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions = {},
): Promise<OpenClawRegisteredAgentDatabase[]> {
  return readRegisteredAgentDatabases(options, true);
}

/** List agent databases recorded in the shared OpenClaw state registry. */
export function listOpenClawRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions = {},
): OpenClawRegisteredAgentDatabase[] {
  const memo = activateRegisteredAgentDatabasesMemo(options);
  if (memo.entries) {
    const entries = cloneRegisteredAgentDatabases(memo.entries);
    return options.includeIncompatibleSchemaVersions
      ? entries
      : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
  }
  // Discovery runs per row in list hot paths, so the legacy-schema gate and the
  // query share one process-held state handle instead of opening two connections.
  const entries = readRegisteredAgentDatabases(
    { ...options, includeIncompatibleSchemaVersions: true },
    false,
  );
  memo.entries = entries;
  const cloned = cloneRegisteredAgentDatabases(entries);
  return options.includeIncompatibleSchemaVersions
    ? cloned
    : cloned.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
}
