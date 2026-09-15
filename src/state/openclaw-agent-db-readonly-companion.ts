import type { DatabaseSync } from "node:sqlite";
import {
  enableNodeSqliteKyselyStatementCache,
  registerNodeSqliteDisposeCallback,
} from "../infra/kysely-sync-cache-state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  readOpenClawAgentDatabaseReadOnly,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "./openclaw-agent-db-readonly-open.js";

type ReadOnlyCompanion = {
  reader: OpenClawAgentReadOnlyDatabaseHandle;
  active: boolean;
  close: () => void;
};

const companions = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseReadOnlyCompanions"),
  () => new WeakMap<DatabaseSync, ReadOnlyCompanion>(),
);

function matchesWriter(reader: OpenClawAgentReadOnlyDatabase, writer: OpenClawAgentDatabase) {
  return (
    isOpenClawAgentDatabasePathCurrent(writer) &&
    isOpenClawAgentDatabasePathCurrent(reader) &&
    readOpenClawAgentDatabaseIdentity(reader).identity ===
      readOpenClawAgentDatabaseIdentity(writer).identity
  );
}

/** Keep committed reads separate from the active writer without reopening per assertion. */
export function withCommittedOpenClawAgentDatabaseReadOnly<T>(
  writer: OpenClawAgentDatabase,
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: { throwOnMissingTable?: boolean },
): OpenClawAgentDatabaseReadOnlyResult<T> {
  let companion = companions.get(writer.db);
  // Nested operations keep their own statement/transaction window and cleanup.
  if (companion?.active) {
    return withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
  }
  if (
    companion &&
    (!matchesWriter(companion.reader, writer) || companion.reader.db.isTransaction)
  ) {
    companion.close();
    companion = undefined;
  }
  if (!companion && !isOpenClawAgentDatabasePathCurrent(writer)) {
    return withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
  }
  if (!companion) {
    const opened = openOpenClawAgentDatabaseReadOnly(options);
    if (!opened.found) {
      return opened;
    }
    const reader = opened.database;
    // A pathname replacement during open keeps the old one-shot read contract.
    if (!matchesWriter(reader, writer)) {
      try {
        return readOpenClawAgentDatabaseReadOnly(reader, operation, behavior);
      } finally {
        reader.close();
      }
    }
    let unregisterDispose = () => {};
    const close = () => {
      if (reader.db.isOpen) {
        reader.close();
      }
      if (companions.get(writer.db)?.reader === reader) {
        companions.delete(writer.db);
      }
      unregisterDispose();
    };
    try {
      enableNodeSqliteKyselyStatementCache(reader.db);
      unregisterDispose = registerNodeSqliteDisposeCallback(writer.db, close);
      companion = { reader, active: false, close };
      companions.set(writer.db, companion);
    } catch (error) {
      close();
      throw error;
    }
  }
  const owned = companion;
  try {
    if (!hasOpenClawAgentReadOnlySchema(owned.reader)) {
      owned.close();
      return { found: false, reason: "schema-missing" };
    }
    owned.active = true;
    return readOpenClawAgentDatabaseReadOnly(owned.reader, operation, behavior);
  } catch (error) {
    owned.close();
    throw error;
  } finally {
    owned.active = false;
    // Never retain a caller's transaction or a handle detached from its current physical owner.
    if (
      !owned.reader.db.isOpen ||
      owned.reader.db.isTransaction ||
      !matchesWriter(owned.reader, writer)
    ) {
      owned.close();
    }
  }
}
