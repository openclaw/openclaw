import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  isSqliteDatabaseAdmissionRetired as isRetired,
  readSqliteDatabaseGeneration,
  advanceSqliteDatabaseGeneration,
  type Admission,
  type ScopedWriteRevision,
} from "./sqlite-database-admission-record.js";
import { hasSqlitePostCommitScope, stageSqliteTransactionState } from "./sqlite-post-commit.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.sqliteDatabaseWriteScopes"), () => ({
  writeScopes: new WeakMap<DatabaseSync, readonly string[]>(),
  pendingWriteScopes: new WeakMap<DatabaseSync, Set<string> | null>(),
  localScopeRevisions: new WeakMap<DatabaseSync, Map<string, ScopedWriteRevision>>(),
  localUnscopedRevisions: new WeakMap<DatabaseSync, number>(),
}));

type SqliteDatabaseWriteScope = string | { sessionId: string };

/** Shared windows and transcripts can affect several logical keys for one session ID. */
export function sqliteSessionIdWriteScope(sessionId: string): { sessionId: string } {
  return { sessionId };
}

/** Scoped revisions borrow physical admission and publication from their existing owner. */
export function createSqliteDatabaseWriteReceipts(owner: {
  admission(this: void, database: DatabaseSync): Admission | undefined;
  pathAdmission(this: void, location: string): Admission | undefined;
  readRevision(this: void, database: DatabaseSync): number | undefined;
  writer(this: void, database: DatabaseSync): Admission | undefined;
  suspended(this: void, database: DatabaseSync): boolean;
  exchange(this: void, record: Admission): void;
  publish(this: void, record: Admission): void;
}) {
  /** A typed owner certifies all session keys affected by this synchronous kernel. */
  function withSqliteDatabaseWriteScope<T>(
    database: DatabaseSync,
    scope: readonly SqliteDatabaseWriteScope[],
    run: () => T,
  ): T {
    const record = owner.admission(database);
    const tracked = record
      ? readSqliteDatabaseGeneration(record, "writeScopeRevision") > 0
      : state.localScopeRevisions.has(database);
    if (!tracked) {
      const value = run();
      if (value instanceof Promise) {
        throw new Error("SQLite write scopes cannot await work");
      }
      return value;
    }
    const keys = normalizedWriteScopes(scope);
    if (
      record &&
      record.writeScopeRevision !== readSqliteDatabaseGeneration(record, "writeScopeRevision")
    ) {
      // Scope registration and retirement use the existing cold metadata exchange.
      owner.exchange(record);
    }
    const previous = state.writeScopes.get(database);
    state.writeScopes.set(database, keys);
    try {
      const value = run();
      if (value instanceof Promise) {
        throw new Error("SQLite write scopes cannot await work");
      }
      return value;
    } finally {
      if (previous) {
        state.writeScopes.set(database, previous);
      } else {
        state.writeScopes.delete(database);
      }
    }
  }

  /** Authority and user callbacks cannot borrow their caller's certified mutation scope. */
  function withoutSqliteDatabaseWriteScope<T>(database: DatabaseSync, run: () => T): T {
    const previous = state.writeScopes.get(database);
    state.writeScopes.delete(database);
    try {
      return run();
    } finally {
      if (previous) {
        state.writeScopes.set(database, previous);
      }
    }
  }

  function ensureWriteScopes(record: Admission, keys: readonly string[]): void {
    let changed = false;
    for (const key of keys) {
      const previous = record.writeScopes.get(key);
      if (!previous || Atomics.load(new Int32Array(previous.state), 1) !== 0) {
        record.writeScopes.set(key, createScopeRevision());
        if (threadId === 0) {
          advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
        }
        changed = true;
      }
    }
    if (changed) {
      // Scope discovery is cold metadata, shared through the existing admission exchange.
      advanceSqliteDatabaseGeneration(record, "publicationRevision");
      owner.publish(record);
    }
  }

  function createScopeRevision(): ScopedWriteRevision {
    return {
      identity: randomUUID(),
      state: new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT),
    };
  }

  /** Deletion owners retire only scopes whose stored identity has actually been removed. */
  function retireSqliteDatabaseWriteScopes(
    database: DatabaseSync,
    scope: readonly SqliteDatabaseWriteScope[],
  ): void {
    const keys = normalizedWriteScopes(scope);
    const record = owner.admission(database);
    const retire = () => {
      if (!record) {
        const local = state.localScopeRevisions.get(database);
        for (const key of keys) {
          local?.delete(key);
        }
        return;
      }
      if (isRetired(record)) {
        return;
      }
      let changed = false;
      for (const key of keys) {
        const revision = record.writeScopes.get(key);
        if (revision && Atomics.exchange(new Int32Array(revision.state), 1, 1) === 0) {
          changed = true;
        }
      }
      if (changed) {
        advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
        advanceSqliteDatabaseGeneration(record, "publicationRevision");
        owner.publish(record);
      }
    };
    if (
      !stageSqliteTransactionState(database, {
        stage() {},
        commit: retire,
        rollback() {},
      }) &&
      !database.isTransaction
    ) {
      retire();
    }
  }

  function scopedWriteToken(
    record: Admission,
    keys: readonly string[],
    pending?: Set<string> | null,
  ): string {
    return JSON.stringify([
      record.identity,
      record.generationId,
      readSqliteDatabaseGeneration(record, "schemaRevision"),
      (readSqliteDatabaseGeneration(record, "unscopedWriteRevision") + (pending === null ? 1 : 0)) |
        0,
      keys.map((key) => [
        key,
        record.writeScopes.get(key)!.identity,
        (Atomics.load(new Int32Array(record.writeScopes.get(key)!.state), 0) +
          (pending?.has(key) ? 1 : 0)) |
          0,
      ]),
    ]);
  }

  function localScopedWriteToken(
    database: DatabaseSync,
    keys: readonly string[],
    pending?: Set<string> | null,
  ): string {
    return JSON.stringify([
      "memory",
      (state.localUnscopedRevisions.get(database) ?? 0) + (pending === null ? 1 : 0),
      keys.map((key) => [
        key,
        state.localScopeRevisions.get(database)!.get(key)!.identity,
        (Atomics.load(new Int32Array(state.localScopeRevisions.get(database)!.get(key)!.state), 0) +
          (pending?.has(key) ? 1 : 0)) |
          0,
      ]),
    ]);
  }

  function normalizedWriteScopes(scope: string | readonly SqliteDatabaseWriteScope[]): string[] {
    const keys = typeof scope === "string" ? [scope] : scope;
    return [
      ...new Set(
        keys.map((key) =>
          typeof key === "string"
            ? JSON.stringify(["key", toUSVString(key)])
            : JSON.stringify(["session-id", toUSVString(key.sessionId)]),
        ),
      ),
    ].toSorted();
  }

  function ensureLocalWriteScopes(database: DatabaseSync, keys: readonly string[]): void {
    const revisions =
      state.localScopeRevisions.get(database) ?? new Map<string, ScopedWriteRevision>();
    for (const key of keys) {
      if (!revisions.has(key)) {
        revisions.set(key, createScopeRevision());
      }
    }
    state.localScopeRevisions.set(database, revisions);
  }

  function readScopedWriteToken(
    database: DatabaseSync,
    scope: string | readonly SqliteDatabaseWriteScope[],
    includePending = false,
  ): string | undefined {
    const keys = normalizedWriteScopes(scope);
    const record = owner.admission(database);
    if (record) {
      ensureWriteScopes(record, keys);
    } else {
      ensureLocalWriteScopes(database, keys);
    }
    if (owner.readRevision(database) === undefined) {
      return undefined;
    }
    const pending = includePending ? state.pendingWriteScopes.get(database) : undefined;
    return record
      ? scopedWriteToken(record, keys, pending)
      : localScopedWriteToken(database, keys, pending);
  }

  /** Per-key receipts survive unrelated committed writes. */
  function readSqliteDatabaseScopedWriteToken(
    database: DatabaseSync,
    scope: string | readonly SqliteDatabaseWriteScope[],
  ): string | undefined {
    return readScopedWriteToken(database, scope);
  }

  function readSqliteDatabaseScopedWriteTokenForPath(
    location: string,
    scope: string | readonly SqliteDatabaseWriteScope[],
  ): string | undefined {
    const keys = normalizedWriteScopes(scope);
    const record = owner.pathAdmission(location);
    if (!record || isRetired(record)) {
      return undefined;
    }
    ensureWriteScopes(record, keys);
    return scopedWriteToken(record, keys);
  }

  /** Capture the exact post-commit token before any fallible publication executes. */
  function readSqliteDatabasePendingScopedWriteToken(
    database: DatabaseSync,
    scope: string | readonly SqliteDatabaseWriteScope[],
  ): string | undefined {
    return readScopedWriteToken(database, scope, true);
  }

  /** Host row caches retain a physical identity and receipt without opening SQLite. */
  function readSqliteDatabaseWriteTokenForPath(location: string): string | undefined {
    const record = owner.pathAdmission(location);
    if (!record || isRetired(record)) {
      return undefined;
    }
    return `${record.identity}:${record.generationId}:${readSqliteDatabaseGeneration(record, "writeRevision")}`;
  }

  /** Predict the token published when the current native mutation settles. */
  function readSqliteDatabasePendingWriteToken(database: DatabaseSync): string | undefined {
    if (
      !database.isOpen ||
      !database.isTransaction ||
      !hasSqlitePostCommitScope(database) ||
      owner.suspended(database)
    ) {
      return undefined;
    }
    const record = owner.writer(database);
    if (!record || isRetired(record)) {
      return undefined;
    }
    return `${record.identity}:${record.generationId}:${(readSqliteDatabaseGeneration(record, "writeRevision") + 1) | 0}`;
  }

  return {
    begin(database: DatabaseSync, unscoped: boolean) {
      const scope = unscoped ? undefined : state.writeScopes.get(database);
      const pending = state.pendingWriteScopes.get(database);
      if (!scope || pending === null) {
        // Unscoped native DML, schema work, and reentrant callbacks explicitly fence the database.
        state.pendingWriteScopes.set(database, null);
      } else {
        const keys = pending ?? new Set<string>();
        for (const key of scope) {
          keys.add(key);
        }
        state.pendingWriteScopes.set(database, keys);
      }
    },
    finish(database: DatabaseSync, record: Admission | undefined) {
      const keys = state.pendingWriteScopes.get(database);
      state.pendingWriteScopes.delete(database);
      let unscoped = !keys;
      if (keys) {
        const local = state.localScopeRevisions.get(database);
        for (const key of keys) {
          const localRevision = local?.get(key);
          if (localRevision) {
            Atomics.add(new Int32Array(localRevision.state), 0, 1);
          }
          const revision = record?.writeScopes.get(key);
          if (revision && Atomics.load(new Int32Array(revision.state), 1) === 0) {
            Atomics.add(new Int32Array(revision.state), 0, 1);
          } else if (
            record &&
            (revision ||
              record.writeScopeRevision !==
                readSqliteDatabaseGeneration(record, "writeScopeRevision"))
          ) {
            // Another isolate may have registered or retired the key during this write.
            unscoped = true;
          }
        }
      }
      if (unscoped) {
        state.localUnscopedRevisions.set(
          database,
          (state.localUnscopedRevisions.get(database) ?? 0) + 1,
        );
        if (record) {
          advanceSqliteDatabaseGeneration(record, "unscopedWriteRevision");
        }
      }
    },
    retireSqliteDatabaseWriteScopes,
    withSqliteDatabaseWriteScope,
    withoutSqliteDatabaseWriteScope,
    readSqliteDatabaseScopedWriteToken,
    readSqliteDatabaseScopedWriteTokenForPath,
    readSqliteDatabasePendingScopedWriteToken,
    readSqliteDatabaseWriteTokenForPath,
    readSqliteDatabasePendingWriteToken,
  };
}
