import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";
import { hasErrnoCode } from "./errno.js";
import {
  isPostgresSqlConnection,
  sqlPublicationAnchor,
  type PostgresSqlConnection,
  type EngineConnection,
} from "./sql-connection.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import { createSqliteDatabaseAdmissionReader } from "./sqlite-database-admission-read.js";
import {
  SqliteDatabaseGenerationSlot,
  SqliteDatabaseAdmissionRegistry,
  type SqliteDatabaseAdmissionCursor,
  readSqliteDatabaseAdmissions,
  readSqliteDatabaseAdmissionIdentity as identity,
  readSqliteDatabaseFactRevision,
  readSqliteDatabaseGeneration,
  advanceSqliteDatabaseGeneration,
  publishSqliteDatabaseFact,
  admitSqliteDatabaseFactValue,
  revokeSqliteDatabaseAdmissionFacts,
  isSqliteDatabaseAdmissionRetired as isRetired,
  type Admission,
  type AdmissionFactValue,
  type SqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissionKey,
  type SqliteDatabaseAdmissionExchange as Exchange,
  type StagedAdmissionFact,
} from "./sqlite-database-admission-record.js";
import {
  integrityVerificationKey,
  SqliteDatabaseCleanCloseSeals,
} from "./sqlite-database-admission-seal.js";
import { createSqliteDatabaseWriteReceipts } from "./sqlite-database-write-receipts.js";
import { getSqliteNativeAdmissionFacts } from "./sqlite-native-admission.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";

export {
  readSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  type SqliteDatabaseAdmissionCursor,
} from "./sqlite-database-admission-record.js";
export type {
  SqliteDatabaseAdmissions,
  SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission-record.js";
export { beginSqliteDatabaseAdmissionOperation } from "./sqlite-native-admission.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.sqliteDatabaseAdmissions"), () => ({
  registry: new SqliteDatabaseAdmissionRegistry(),
  connections: new WeakMap<DatabaseSync, Admission>(),
  openedIdentities: new WeakMap<DatabaseSync, string>(),
  unproven: new WeakSet<DatabaseSync>(),
  suspended: new WeakSet<DatabaseSync>(),
  local: new WeakMap<DatabaseSync, Map<string, StagedAdmissionFact>>(),
  rolledBack: new WeakSet<DatabaseSync>(),
  dataWriters: new WeakMap<DatabaseSync, Admission | undefined>(),
  localWriteRevisions: new WeakMap<DatabaseSync, number>(),
  writeListeners: new WeakMap<Admission, Set<() => void>>(),
  ddlRevisions: new WeakMap<DatabaseSync, number>(),
  schemaDirty: new WeakSet<DatabaseSync>(),
  localSchemaRevisions: new Map<string, number>(),
  misses: new WeakMap<Admission, Map<string, number>>(),
  exchange: new AsyncLocalStorage<Exchange>(),
  exchanging: false,
  publication: 0,
  seals: new SqliteDatabaseCleanCloseSeals(publishFact, {
    retain: (record) => state.registry.changeReferences(record, 1),
    release: releaseReference,
  }),
}));

/** Independent readers have no writer-fact relay; retain facts only with their native readers. */
export const useConnectionScopedSqliteDatabaseAdmissionFacts = (): void =>
  state.registry.useConnectionScopedFacts();

export function readSqliteDatabaseCleanClose(location: string): boolean {
  const currentIdentity = prepareSqliteDatabaseAdmission(location);
  const record = pathAdmission(location);
  return (
    record !== undefined &&
    record.identity === currentIdentity &&
    Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.sealPresent) === 1
  );
}

/** Maintenance can invalidate restart proof while retaining its freshly checked runtime facts. */
export function invalidateSqliteDatabaseCleanClose(location: string): void {
  state.seals.invalidate(location, pathAdmission(location));
}

export function readSqliteDatabaseIntegrityVerification(
  source: string | DatabaseSync,
): { verifiedAt: number } | undefined {
  const verifiedAt =
    typeof source === "string"
      ? getOrLoadSqliteDatabaseAdmissionForPath(source, integrityVerificationKey, () => undefined)
      : getSqliteDatabaseAdmission(source, integrityVerificationKey);
  return verifiedAt === undefined ? undefined : { verifiedAt };
}

export function recordSqliteDatabaseIntegrity(db: DatabaseSync, verifiedAt = Date.now()): void {
  publishSqliteDatabaseAdmission(db, integrityVerificationKey, verifiedAt);
}

/** Capture admitted facts before close; publish only after successful TRUNCATE and native close. */
export function prepareSqliteDatabaseCleanClose(database: DatabaseSync) {
  return state.seals.prepare(
    database,
    admission(database),
    getSqliteDatabaseAdmission(database, integrityVerificationKey),
  );
}

const reader = createSqliteDatabaseAdmissionReader({
  state,
  admission,
  pathAdmission,
  exchange,
  publishFact,
  retain: (record) => {
    if (state.registry.changeReferences(record, 1)) {
      exchange(record);
    }
  },
  release: releaseReference,
});
export const {
  getSqliteDatabaseAdmission,
  getOrLoadSqliteDatabaseAdmissionForPath,
  hasSqliteDatabaseSchemaAdmissionForPath,
  getSqliteDatabaseAdmissionIdentityForPath,
  hasSqliteDatabaseSchemaAdmissionForIdentity,
} = reader;

const scopedWrites = createSqliteDatabaseWriteReceipts({
  admission,
  pathAdmission,
  writeListeners: state.writeListeners,
  readRevision: readSqliteDatabaseWriteRevision,
  writer: (database) => state.dataWriters.get(database),
  suspended: (database) => state.suspended.has(database),
  publish(record, keys) {
    state.registry.publish(record, keys);
    exchange(record);
  },
});
export const {
  onSqliteDatabaseWriteSettled,
  retireSqliteDatabaseWriteScopes,
  withSqliteDatabaseWriteScope,
  withoutSqliteDatabaseWriteScope,
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabaseScopedWriteTokenForPath,
  readSqliteDatabaseScopedWriteTokensForPath,
  readSqliteDatabasePendingScopedWriteToken,
  readSqliteDatabaseWriteTokenForPath,
  readSqliteDatabasePendingWriteToken,
} = scopedWrites;
export { sqliteSessionIdWriteScope } from "./sqlite-database-write-receipts.js";

function exchange(target: string | Admission, create?: boolean): void {
  const current = state.exchange.getStore();
  if (!current || state.exchanging) {
    return;
  }
  state.exchanging = true;
  try {
    const scope = typeof target === "string" ? { location: target } : { admissions: [target] };
    const admissions = state.registry.captureExchange(scope, target);
    installSqliteDatabaseAdmissions(
      current(
        admissions,
        // Publications already name their generation; only opens request pathname discovery.
        typeof target === "string" ? target : undefined,
        create,
      ),
    );
  } catch (error) {
    state.registry.resetExchangeCursor();
    throw error;
  } finally {
    state.exchanging = false;
  }
}

/** Identity descriptors stay open for the process: closing one can release SQLite's POSIX locks. */
export function retainSqliteDatabaseAdmissionLocation(location: string): void {
  const observed = fs.statSync(location, { bigint: true });
  if (!observed.isFile()) {
    return;
  }
  const key = identity(observed);
  const previous = state.registry.records.get(key);
  if (previous && !isRetired(previous)) {
    state.registry.observeLocation(location, key);
    state.seals.load(previous);
    return;
  }
  // A worker's unmanaged descriptors close on exit and can release sibling SQLite POSIX locks.
  // Core workers borrow host custody through the existing exchange; raw workers keep native checks.
  if (threadId !== 0) {
    return;
  }
  const descriptor = state.registry.descriptors.get(key)?.descriptor ?? fs.openSync(location, "r");
  // Never close a source descriptor while another native connection may hold POSIX locks.
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile() || identity(opened) !== key) {
    throw new Error("SQLite database changed while retaining its admission identity");
  }
  const record = state.registry.retainDescriptor(
    fs.realpathSync.native(location),
    descriptor,
    opened,
  );
  state.registry.observeLocation(location, record.identity);
  state.seals.load(record);
}

function pathAdmission(location: string): Admission | undefined {
  let retained = state.registry.forLocation(location);
  if (!retained) {
    exchange(location);
    retained = state.registry.forLocation(location);
  }
  if (retained) {
    state.seals.load(retained);
    return retained;
  }
  try {
    retainSqliteDatabaseAdmissionLocation(location);
    return state.registry.forLocation(location);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** Resolve SQLite's absolute URLs and encoded filename form at filesystem boundaries. */
export function resolveSqliteDatabaseFilePath(location: string): string {
  if (!location.startsWith("file:")) {
    return location;
  }
  const [uriFilename = ""] = location.slice("file:".length).split(/[?#]/u, 1);
  return uriFilename.startsWith("/") ? fileURLToPath(location) : decodeURIComponent(uriFilename);
}

/** Bracket native open so a pathname swap cannot lend the replacement file's admission. */
export function prepareSqliteDatabaseAdmission(
  location: string,
  options: { create?: boolean } = {},
): string | undefined {
  let filename = location;
  let create = options.create;
  if (!filename || filename === ":memory:") {
    return undefined;
  }
  if (filename.startsWith("file:")) {
    const url = new URL(filename);
    if (url.searchParams.get("mode") === "memory") {
      return undefined;
    }
    if (["ro", "rw"].includes(url.searchParams.get("mode") ?? "")) {
      create = false;
    }
    filename = resolveSqliteDatabaseFilePath(filename);
    if (!filename || filename === ":memory:") {
      return undefined;
    }
  }
  try {
    const file = fs.statSync(filename, { bigint: true });
    if (!file.isFile()) {
      return undefined;
    }
    const observed = identity(file);
    state.registry.observeLocation(filename, observed);
    return observed;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      if (!create) {
        return undefined;
      }
      if (threadId !== 0) {
        const managed = state.exchange.getStore() !== undefined;
        exchange(filename, true);
        const opened = prepareSqliteDatabaseAdmission(filename);
        if (managed && opened === undefined) {
          throw new Error(`SQLite worker file creation requires host authority: ${filename}`, {
            cause: error,
          });
        }
        return opened;
      }
      let descriptor: number;
      try {
        // Match SQLite's Unix creation mode, including the process umask.
        descriptor = fs.openSync(filename, "wx", 0o644);
      } catch (creationError) {
        if (hasErrnoCode(creationError, "EEXIST")) {
          return prepareSqliteDatabaseAdmission(filename);
        }
        throw creationError;
      }
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const record = state.registry.retainDescriptor(
        fs.realpathSync.native(filename),
        descriptor,
        opened,
      );
      state.seals.markCreated(record);
      if (prepareSqliteDatabaseAdmission(filename) !== record.identity) {
        throw new Error("SQLite database changed identity during file creation", { cause: error });
      }
      return record.identity;
    }
    throw error;
  }
}

export function bindSqliteDatabaseAdmission(database: DatabaseSync, expected?: string): void {
  state.connections.delete(database);
  state.openedIdentities.delete(database);
  state.unproven.delete(database);
  const location = database.location();
  if (!location || location === ":memory:") {
    return;
  }
  const observed = prepareSqliteDatabaseAdmission(location);
  if (expected !== undefined && observed !== expected) {
    throw new Error("SQLite database changed identity during native open");
  }
  if (!observed) {
    return;
  }
  state.openedIdentities.set(database, observed);
  if (expected === undefined) {
    // Unhosted raw workers cannot prove which file SQLite created; never lend that handle's facts.
    state.unproven.add(database);
    return;
  }
  const record = state.registry.records.get(observed);
  if (record && !isRetired(record)) {
    retainConnection(database, record);
  }
}

function admission(database: DatabaseSync, create = true): Admission | undefined {
  const expected = state.openedIdentities.get(database);
  if (!database.isOpen || expected === undefined || state.unproven.has(database)) {
    return undefined;
  }
  const retained = state.connections.get(database);
  if (retained) {
    // A retained descriptor cannot change its physical file when the path is replaced.
    return isRetired(retained) ? undefined : retained;
  }
  const location = database.location();
  if (!location || location === ":memory:") {
    return undefined;
  }
  const discover = create && !database.isTransaction;
  const record = discover ? pathAdmission(location) : state.registry.records.get(expected);
  if (record && record.identity !== expected) {
    throw new Error("SQLite database changed identity before admission");
  }
  return record && !isRetired(record) ? retainConnection(database, record) : undefined;
}

function retainConnection(database: DatabaseSync, record: Admission): Admission {
  const expected = record.identity;
  let current = record;
  try {
    for (;;) {
      if (current.identity !== expected) {
        throw new Error("SQLite database changed identity during native open");
      }
      const publish = state.registry.changeReferences(current, 1);
      let retained = false;
      try {
        if (publish) {
          exchange(current);
        }
        const retirement = readSqliteDatabaseGeneration(current, "retired");
        if (retirement === 0) {
          state.connections.set(database, current);
          retained = true;
          return current;
        }
        if (retirement !== 2) {
          throw new Error("SQLite database admission retired during native open");
        }
      } finally {
        if (!retained) {
          state.registry.changeReferences(current, -1);
        }
      }
      // The last known reader can close before the host receives this worker's
      // first reference. Bind only after the host acknowledges its live generation.
      const location = database.location();
      const replacement = database.isTransaction
        ? state.registry.records.get(expected)
        : location
          ? pathAdmission(location)
          : undefined;
      if (!replacement || isRetired(replacement)) {
        throw new Error("SQLite database admission unavailable during native open");
      }
      current = replacement;
    }
  } catch (error) {
    state.openedIdentities.delete(database);
    throw error;
  }
}

/** Native close retires row receipts while descriptor custody retains opted-in physical facts. */
export function releaseSqliteDatabaseAdmission(database: DatabaseSync): void {
  const record = state.connections.get(database);
  if (state.openedIdentities.delete(database) && record) {
    state.local.delete(database);
    releaseReference(record);
  }
}

function releaseReference(record: Admission): void {
  if (state.registry.changeReferences(record, -1)) {
    state.localSchemaRevisions.delete(record.identity);
    exchange(record);
  }
}

function publishFact<T>(
  record: Admission,
  key: Pick<SqliteDatabaseAdmissionKey<T>, "name" | "schemaDependent" | "lifetime" | "writer">,
  value: AdmissionFactValue,
  revision: number,
): void {
  if (key.writer === "host" && threadId !== 0) {
    throw new Error("SQLite host-owned admission facts require the host publisher");
  }
  if (
    !publishSqliteDatabaseFact(record, key, value, revision, `${threadId}:${++state.publication}`)
  ) {
    return;
  }
  state.registry.publish(record);
  exchange(record);
}

/** Publish one row-cache revision when a local native write settles. */
export function beginSqliteDatabaseWrite(database: DatabaseSync, unscoped = false): void {
  const record = admission(database);
  if (
    record &&
    Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.sealPresent) === 1
  ) {
    // Unlink before effect. A crash/torn publication can only force revalidation;
    // changed WAL or file metadata rejects any unlink lost during power failure.
    state.seals.invalidate(record.location, record);
  }
  scopedWrites.begin(database, unscoped);
  if (state.dataWriters.has(database)) {
    return;
  }
  state.dataWriters.set(database, record);
  if (record) {
    Atomics.add(new Int32Array(record.references.get(threadId)!), 1, 1);
  }
}

/** Native settlement invalidates row caches, including failed or rolled-back writes. */
export function finishSqliteDatabaseWrite(database: DatabaseSync): void {
  if (!state.dataWriters.has(database)) {
    return;
  }
  const record = state.dataWriters.get(database);
  state.dataWriters.delete(database);
  state.localWriteRevisions.set(database, (state.localWriteRevisions.get(database) ?? 0) + 1);
  scopedWrites.finish(database, record);
  if (record) {
    advanceSqliteDatabaseGeneration(record, "writeRevision");
    // Clear only after publishing both receipts; a native COMMIT can outlive its worker.
    Atomics.sub(new Int32Array(record.references.get(threadId)!), 1, 1);
    const listeners = state.writeListeners.get(record);
    if (listeners) {
      notifyListeners(listeners, undefined);
    }
  }
}

/** Ordinary reads consume the last committed writer revision without a writer census. */
export function readSqliteDatabaseWriteRevision(connection: EngineConnection): number | undefined {
  const database = sqlPublicationAnchor(connection);
  if (!database.isOpen || state.suspended.has(database)) {
    return undefined;
  }
  const record = admission(database);
  if (!record) {
    const location = database.location();
    return !location || location === ":memory:"
      ? (state.localWriteRevisions.get(database) ?? 0)
      : undefined;
  }
  return readSqliteDatabaseGeneration(record, "writeRevision");
}

/** TEMP-trigger owners already see their own writes and only need sibling settlement. */
export function readSqliteDatabaseSiblingWriteRevision(
  connection: EngineConnection,
): number | undefined {
  const database = sqlPublicationAnchor(connection);
  const revision = readSqliteDatabaseWriteRevision(database);
  return revision === undefined
    ? undefined
    : (revision - (state.localWriteRevisions.get(database) ?? 0)) | 0;
}

/** Settle interrupted native writes before releasing the departed worker's handles. */
export function trackSqliteDatabaseAdmissionWorker(worker: {
  readonly threadId: number;
  once(event: "exit", listener: (code: number | undefined) => void): unknown;
}): void {
  const owner = worker.threadId;
  worker.once("exit", () => {
    for (const record of state.registry.records.values()) {
      scopedWrites.settleWorker(record, owner);
    }
    state.registry.releaseWorker(owner);
  });
}

export function hasPendingSqliteDatabaseSchemaMutation(
  database: DatabaseSync | PostgresSqlConnection,
): boolean {
  const anchor = sqlPublicationAnchor(database);
  return database.isTransaction && state.schemaDirty.has(anchor);
}

export function publishSqliteDatabaseAdmission<T>(
  database: DatabaseSync | PostgresSqlConnection,
  key: SqliteDatabaseAdmissionKey<T>,
  value: T,
  options: { schemaRevision?: number } = {},
): void {
  const anchor = sqlPublicationAnchor(database);
  const record = admission(anchor, !database.isTransaction);
  if (!record || isRetired(record) || state.suspended.has(anchor)) {
    return;
  }
  if (key.writer === "host" && threadId !== 0) {
    throw new Error("SQLite host-owned admission facts require the host publisher");
  }
  const revision =
    (key.schemaDependent ? options.schemaRevision : undefined) ??
    readSqliteDatabaseFactRevision(record, key.schemaDependent);
  const native = isPostgresSqlConnection(database)
    ? undefined
    : getSqliteNativeAdmissionFacts(database);
  const admitted = admitSqliteDatabaseFactValue(key, value);
  if (!native && !database.isTransaction) {
    publishFact(record, key, admitted, revision);
    return;
  }
  const staged: StagedAdmissionFact = {
    ...admitted,
    revision,
    schemaDependent: key.schemaDependent === true,
    ddlRevision: state.ddlRevisions.get(anchor) ?? 0,
  };
  if (native) {
    native.set(key.name, staged);
    return;
  }
  const local = state.local.get(anchor) ?? new Map<string, StagedAdmissionFact>();
  state.local.set(anchor, local);
  const previous = local.get(key.name);
  const restore = () => {
    if (state.local.get(anchor) !== local) {
      return;
    }
    if (previous === undefined) {
      local.delete(key.name);
    } else {
      local.set(key.name, previous);
    }
  };
  stageSqliteTransactionState(anchor, {
    stage: () => local.set(key.name, staged),
    rollback: restore,
    commit: () => {
      if (state.local.get(anchor) === local && local.get(key.name) === staged) {
        local.delete(key.name);
        if (
          staged.revision === readSqliteDatabaseFactRevision(record, staged.schemaDependent) &&
          (!staged.schemaDependent || staged.ddlRevision === (state.ddlRevisions.get(anchor) ?? 0))
        ) {
          publishFact(record, key, staged, staged.revision);
        }
      }
    },
  });
}

/** Track uncommitted DDL separately so it cannot revive a receipt validated before a later change. */
export function invalidateLocalSqliteSchemaAdmissions(
  database: DatabaseSync | PostgresSqlConnection,
): void {
  const anchor = sqlPublicationAnchor(database);
  const revision = state.ddlRevisions.get(anchor) ?? 0;
  const dirty = state.schemaDirty.has(anchor);
  const stage = () => {
    state.ddlRevisions.set(anchor, revision + 1);
    state.schemaDirty.add(anchor);
  };
  if (
    !stageSqliteTransactionState(anchor, {
      stage,
      commit: () => {},
      rollback: () => {
        state.ddlRevisions.set(anchor, revision);
        if (!dirty) {
          state.schemaDirty.delete(anchor);
        }
      },
    })
  ) {
    stage();
  }
}

/** Raw rollback cannot restore staging boundaries; require new facts in any remaining transaction. */
export function discardSqliteDatabaseTransactionAdmissions(
  database: DatabaseSync | PostgresSqlConnection,
): void {
  const anchor = sqlPublicationAnchor(database);
  const record = admission(anchor, false);
  for (const pending of [
    isPostgresSqlConnection(database) ? undefined : getSqliteNativeAdmissionFacts(database),
    state.local.get(anchor),
  ]) {
    for (const key of pending?.keys() ?? []) {
      const previous = record?.facts.get(key);
      if (previous) {
        Atomics.store(new Int32Array(previous.current), 0, 0);
      }
    }
    pending?.clear();
  }
  state.local.delete(anchor);
  state.rolledBack.add(anchor);
  if (!database.isTransaction) {
    state.schemaDirty.delete(anchor);
  }
}

/** The DDL owner advances committed format and acknowledges only its final validated receipts. */
export function publishSqliteDatabaseSchemaChange(
  database: DatabaseSync | PostgresSqlConnection,
): void {
  const anchor = sqlPublicationAnchor(database);
  const record = admission(anchor, false);
  if (record) {
    const previous = advanceSqliteDatabaseGeneration(record, "schemaRevision");
    const ddlRevision = state.ddlRevisions.get(anchor) ?? 0;
    for (const fact of state.local.get(anchor)?.values() ?? []) {
      if (fact.schemaDependent && fact.revision === previous && fact.ddlRevision === ddlRevision) {
        fact.revision = previous + 1;
      }
    }
  } else {
    const fileIdentity = state.openedIdentities.get(anchor);
    if (fileIdentity) {
      // Unhosted threads still share committed schema changes between their own handles.
      state.localSchemaRevisions.set(
        fileIdentity,
        (state.localSchemaRevisions.get(fileIdentity) ?? 0) + 1,
      );
    }
  }
  if (!database.isTransaction) {
    state.schemaDirty.delete(anchor);
  }
}

function revoke(record: Admission | undefined, location = record?.location): void {
  if (location) {
    state.seals.invalidate(location, record);
  }
  revokeSqliteDatabaseAdmissionFacts(record);
}

export function revokeSqliteDatabaseAdmissions(database: DatabaseSync): void {
  // A close failure can report corruption after native disposal; keep revocation on that file.
  revoke(state.connections.get(database) ?? admission(database));
  state.local.delete(database);
}

export function revokeSqliteDatabaseAdmissionsForPath(location: string): void {
  revoke(pathAdmission(location), location);
}

/** Explicit removal or maintenance calls this only after its owner has joined native consumers. */
export function retireSqliteDatabaseAdmissionForPath(
  location: string,
  options: { requireSoleDescriptor?: boolean } = {},
): void {
  const observed = prepareSqliteDatabaseAdmission(location);
  if (!observed) {
    return;
  }
  state.localSchemaRevisions.delete(observed);
  const record = threadId === 0 ? state.registry.records.get(observed) : pathAdmission(location);
  if (state.registry.retireDescriptor(observed, options) && record) {
    exchange(record);
  }
}

export function getSqliteDatabaseSchemaRevision(connection: EngineConnection): number | undefined {
  const database = sqlPublicationAnchor(connection);
  const record = admission(database);
  if (record) {
    return readSqliteDatabaseGeneration(record, "schemaRevision");
  }
  const fileIdentity = state.openedIdentities.get(database);
  return fileIdentity ? (state.localSchemaRevisions.get(fileIdentity) ?? 0) : undefined;
}

export function suspendSqliteDatabaseAdmission(database: DatabaseSync, suspended: boolean): void {
  if (suspended) {
    state.suspended.add(database);
  } else {
    state.suspended.delete(database);
  }
}

export function captureSqliteDatabaseAdmissions(
  cursor?: SqliteDatabaseAdmissionCursor,
  scope?: { location?: string; admissions?: SqliteDatabaseAdmissions },
): SqliteDatabaseAdmissions {
  return state.registry.capture(cursor, scope);
}

export function installSqliteDatabaseAdmissions(admissions: SqliteDatabaseAdmissions): void {
  state.registry.install(admissions);
}

export function withSqliteDatabaseAdmissionExchange<T>(
  exchangeOwner: Exchange,
  operation: () => T,
): T {
  return state.exchange.run(exchangeOwner, operation);
}

/** Unsupported worker hosts retain native validation instead of waiting for unpublished facts. */
export function canShareSqliteDatabaseAdmissions(): boolean {
  return threadId === 0 || state.exchange.getStore() !== undefined;
}

const inherited = readSqliteDatabaseAdmissions(getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY));
if (inherited) {
  installSqliteDatabaseAdmissions(inherited);
  // The parent already owns the snapshot inherited by this Worker.
  state.registry.captureExchange();
}
