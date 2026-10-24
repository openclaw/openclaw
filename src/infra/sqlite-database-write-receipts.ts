import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { sqlPublicationAnchor, type EngineConnection } from "./sql-connection.js";
import {
  isSqliteDatabaseAdmissionRetired as isRetired,
  readSqliteDatabaseGeneration,
  advanceSqliteDatabaseGeneration,
  retainSqliteDatabaseWriteScope,
  pruneSqliteDatabaseWriteScopes,
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

type SqliteDatabaseWriteScope = string | { sessionId: string; partition?: string };

/** Shared windows and transcripts can affect several logical keys for one session ID. */
export function sqliteSessionIdWriteScope(sessionId: string): { sessionId: string } {
  return { sessionId };
}

/** Scoped revisions borrow physical admission and publication from their existing owner. */
export function createSqliteDatabaseWriteReceipts(owner: {
  admission(this: void, database: DatabaseSync): Admission | undefined;
  pathAdmission(this: void, location: string): Admission | undefined;
  retain(this: void, record: Admission): void;
  release(this: void, record: Admission): void;
  writeListeners: WeakMap<Admission, Set<() => void>>;
  readRevision(this: void, database: DatabaseSync): number | undefined;
  writer(this: void, database: DatabaseSync): Admission | undefined;
  suspended(this: void, database: DatabaseSync): boolean;
  publish(this: void, record: Admission, keys: readonly string[]): void;
}) {
  /** Local sibling writers notify maintenance after publishing their shared write revision. */
  function onSqliteDatabaseWriteSettled(
    connection: EngineConnection,
    listener: () => void,
  ): (() => void) | undefined {
    const database = sqlPublicationAnchor(connection);
    const record = owner.admission(database);
    if (!record) {
      return undefined;
    }
    let listeners = owner.writeListeners.get(record);
    if (!listeners) {
      listeners = new Set();
      owner.writeListeners.set(record, listeners);
    }
    return registerListener(listeners, listener);
  }

  /** An interrupted native write may have committed before its receipt was published. */
  function settleWorker(record: Admission, worker: number): void {
    const references = worker > 0 ? record.references.get(worker) : undefined;
    if (references && Atomics.exchange(new Int32Array(references), 1, 0) > 0) {
      advanceSqliteDatabaseGeneration(record, "writeRevision");
      advanceSqliteDatabaseGeneration(record, "unscopedWriteRevision");
      const listeners = owner.writeListeners.get(record);
      if (listeners) {
        notifyListeners(listeners, undefined);
      }
    }
  }
  /** A typed owner certifies all session keys affected by this synchronous kernel. */
  function withSqliteDatabaseWriteScope<T>(
    connection: EngineConnection,
    scope: readonly SqliteDatabaseWriteScope[],
    run: () => T,
  ): T {
    const database = sqlPublicationAnchor(connection);
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
  function withoutSqliteDatabaseWriteScope<T>(connection: EngineConnection, run: () => T): T {
    const database = sqlPublicationAnchor(connection);
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

  function ensureWriteScopes(
    record: Admission,
    keys: readonly string[],
    pins?: ScopedWriteRevision[],
  ): void {
    let changed = false;
    for (const key of keys) {
      let revision = record.writeScopes.get(key);
      if (
        !revision ||
        Atomics.load(revision.state, 1) !== 0 ||
        (pins && !pinWriteScope(revision))
      ) {
        revision = createScopeRevision();
        if (pins) {
          Atomics.store(revision.state, 2, 1);
        }
        if (threadId === 0) {
          advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
        }
        changed = true;
      }
      if (pins) {
        pins.push(revision);
      }
      retainSqliteDatabaseWriteScope(record, key, revision);
    }
    if (changed) {
      // Scope discovery is cold metadata, shared through the existing admission exchange.
      advanceSqliteDatabaseGeneration(record, "publicationRevision");
      owner.publish(record, keys);
    }
  }

  function pinWriteScope(revision: ScopedWriteRevision): boolean {
    let pins = Atomics.load(revision.state, 2);
    while (pins >= 0) {
      const previous = Atomics.compareExchange(revision.state, 2, pins, pins + 1);
      if (previous === pins) {
        return true;
      }
      pins = previous;
    }
    return false;
  }

  function createScopeRevision(): ScopedWriteRevision {
    return {
      identity: randomUUID(),
      state: new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT)),
    };
  }

  /** Keep exact receipts through asynchronous source preparation and its final effect. */
  function retainSqliteDatabaseWriteScopesForPath(
    location: string,
    scope: readonly SqliteDatabaseWriteScope[],
  ): (() => void) | undefined {
    const record = owner.pathAdmission(location);
    if (!record || isRetired(record)) {
      return undefined;
    }
    const pins: ScopedWriteRevision[] = [];
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      try {
        for (const revision of pins) {
          Atomics.sub(revision.state, 2, 1);
        }
        if (pins.length > 0 && !isRetired(record) && pruneSqliteDatabaseWriteScopes(record)) {
          advanceSqliteDatabaseGeneration(record, "publicationRevision");
          owner.publish(record, []);
        }
      } finally {
        owner.release(record);
      }
    };
    try {
      owner.retain(record);
      ensureWriteScopes(record, normalizedWriteScopes(scope), pins);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Deletion owners retire only scopes whose stored identity has actually been removed. */
  function retireSqliteDatabaseWriteScopes(
    connection: EngineConnection,
    scope: readonly SqliteDatabaseWriteScope[],
  ): void {
    const database = sqlPublicationAnchor(connection);
    const keys = normalizedWriteScopes(scope);
    const record = owner.admission(database);
    const retire = () => {
      const revisions = record?.writeScopes ?? state.localScopeRevisions.get(database);
      const families = scope.flatMap((key) =>
        typeof key !== "string" && key.partition === undefined
          ? [normalizedWriteScopes([key])[0]!.slice(0, -1) + ","]
          : [],
      );
      // Session deletion also retires navigation pages from earlier, longer transcripts.
      for (const key of revisions?.keys() ?? []) {
        if (families.some((prefix) => key.startsWith(prefix))) {
          keys.push(key);
        }
      }
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
        if (revision && Atomics.exchange(revision.state, 1, 1) === 0) {
          changed = true;
        }
      }
      if (changed) {
        advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
        advanceSqliteDatabaseGeneration(record, "publicationRevision");
        owner.publish(record, keys);
      }
    };
    if (
      !stageSqliteTransactionState(database, {
        commit: retire,
      }) &&
      !connection.isTransaction
    ) {
      retire();
    }
  }

  function scopedWriteToken(
    record: Admission,
    keys: readonly string[],
    pending?: Set<string> | null,
  ): string {
    const scopes: Array<[string, string, number]> = [];
    for (const key of keys) {
      const revision = record.writeScopes.get(key);
      // Capacity cannot revoke an active writer's receipt. Fall back to the database
      // revision, which invalidates on every write and needs no retained scope cell.
      if (!revision || Atomics.load(revision.state, 1) !== 0) {
        return JSON.stringify([
          record.identity,
          record.generationId,
          readSqliteDatabaseGeneration(record, "schemaRevision"),
          "database",
          (readSqliteDatabaseGeneration(record, "writeRevision") +
            (pending !== undefined ? 1 : 0)) |
            0,
          keys,
        ]);
      }
      scopes.push([
        key,
        revision.identity,
        (Atomics.load(revision.state, 0) + (pending?.has(key) ? 1 : 0)) | 0,
      ]);
    }
    return JSON.stringify([
      record.identity,
      record.generationId,
      readSqliteDatabaseGeneration(record, "schemaRevision"),
      (readSqliteDatabaseGeneration(record, "unscopedWriteRevision") + (pending === null ? 1 : 0)) |
        0,
      scopes,
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
        (Atomics.load(state.localScopeRevisions.get(database)!.get(key)!.state, 0) +
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
            : JSON.stringify([
                "session-id",
                toUSVString(key.sessionId),
                ...(key.partition === undefined ? [] : [toUSVString(key.partition)]),
              ]),
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
    pending?: Set<string> | null,
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
    return record
      ? scopedWriteToken(record, keys, pending)
      : localScopedWriteToken(database, keys, pending);
  }

  /** Per-key receipts survive unrelated committed writes. */
  function readSqliteDatabaseScopedWriteToken(
    connection: EngineConnection,
    scope: string | readonly SqliteDatabaseWriteScope[],
  ): string | undefined {
    return readScopedWriteToken(sqlPublicationAnchor(connection), scope);
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

  /** A cohort discovers all dependency scopes in one admission publication. */
  function readSqliteDatabaseScopedWriteTokensForPath(
    location: string,
    scopes: readonly (string | readonly SqliteDatabaseWriteScope[])[],
  ): string[] | undefined {
    const record = owner.pathAdmission(location);
    if (!record || isRetired(record)) {
      return undefined;
    }
    const groups = scopes.map(normalizedWriteScopes);
    ensureWriteScopes(record, groups.flat());
    return groups.map((keys) => scopedWriteToken(record, keys));
  }

  /** Capture the exact post-commit token before any fallible publication executes. */
  function readSqliteDatabasePendingScopedWriteToken(
    connection: EngineConnection,
    scope: string | readonly SqliteDatabaseWriteScope[],
  ): string | undefined {
    const database = sqlPublicationAnchor(connection);
    return readScopedWriteToken(database, scope, state.pendingWriteScopes.get(database));
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
  function readSqliteDatabasePendingWriteToken(connection: EngineConnection): string | undefined {
    const database = sqlPublicationAnchor(connection);
    if (
      !connection.isOpen ||
      !connection.isTransaction ||
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
            Atomics.add(localRevision.state, 0, 1);
          }
          const revision = record?.writeScopes.get(key);
          if (revision && Atomics.load(revision.state, 1) === 0) {
            Atomics.add(revision.state, 0, 1);
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
    settleWorker,
    onSqliteDatabaseWriteSettled,
    retireSqliteDatabaseWriteScopes,
    retainSqliteDatabaseWriteScopesForPath,
    withSqliteDatabaseWriteScope,
    withoutSqliteDatabaseWriteScope,
    readSqliteDatabaseScopedWriteToken,
    readSqliteDatabaseScopedWriteTokenForPath,
    readSqliteDatabaseScopedWriteTokensForPath,
    readSqliteDatabasePendingScopedWriteToken,
    readSqliteDatabaseWriteTokenForPath,
    readSqliteDatabasePendingWriteToken,
  };
}
