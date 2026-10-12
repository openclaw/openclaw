import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasErrnoCode } from "./errno.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  SqliteDatabaseGenerationSlot,
  SqliteDatabaseAdmissionRegistry,
  hasSqliteDatabaseSchemaAdmission,
  type SqliteDatabaseAdmissionCursor,
  readSqliteDatabaseAdmissions,
  readSqliteDatabaseAdmissionIdentity as identity,
  readSqliteDatabaseFactRevision,
  readSqliteDatabaseRecordWriteRevision as readWriteRevision,
  publishSqliteDatabaseFact,
  isSqliteDatabaseAdmissionRetired as isRetired,
  isSqliteDatabaseAdmissionFactCurrent as valid,
  type Admission,
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
import { schemaAdmission } from "./sqlite-schema-admission.js";
import {
  isSoleDatabaseFileDescriptor,
  type DatabaseFileIdentity,
} from "./sqlite-worker-identity.js";

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
  ddlRevisions: new WeakMap<DatabaseSync, number>(),
  schemaDirty: new WeakSet<DatabaseSync>(),
  localSchemaRevisions: new Map<string, number>(),
  misses: new WeakMap<Admission, Map<string, number>>(),
  exchange: new AsyncLocalStorage<Exchange>(),
  exchanging: false,
  publication: 0,
  seals: new SqliteDatabaseCleanCloseSeals(publishFact),
}));

export function readSqliteDatabaseCleanClose(location: string): boolean {
  const record = pathAdmission(location);
  return (
    record !== undefined &&
    Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.sealPresent) === 1
  );
}

/** Maintenance can invalidate restart proof while retaining its freshly checked runtime facts. */
export function invalidateSqliteDatabaseCleanClose(location: string): void {
  state.seals.invalidate(location, pathAdmission(location));
}

export function readSqliteDatabaseIntegrityVerification(
  location: string,
): { verifiedAt: number } | undefined {
  const verifiedAt = getOrLoadSqliteDatabaseAdmissionForPath(
    location,
    integrityVerificationKey,
    () => undefined,
  );
  return verifiedAt === undefined ? undefined : { verifiedAt };
}

export function recordSqliteDatabaseIntegrity(database: DatabaseSync): void {
  publishSqliteDatabaseAdmission(database, integrityVerificationKey, Date.now());
}

/** Capture admitted facts before close; publish only after successful TRUNCATE and native close. */
export function prepareSqliteDatabaseCleanClose(database: DatabaseSync): () => boolean {
  return state.seals.prepare(
    database,
    admission(database),
    getSqliteDatabaseAdmission(database, integrityVerificationKey),
  );
}

const scopedWrites = createSqliteDatabaseWriteReceipts({
  admission,
  pathAdmission,
  readRevision: readSqliteDatabaseWriteRevision,
  writer: (database) => state.dataWriters.get(database),
  suspended: (database) => state.suspended.has(database),
  exchange,
  publish(record) {
    state.registry.publish(record);
    exchange(record);
  },
});
export const {
  withSqliteDatabaseWriteScope,
  withoutSqliteDatabaseWriteScope,
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabaseScopedWriteTokenForPath,
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
    installSqliteDatabaseAdmissions(
      current(
        captureSqliteDatabaseAdmissions(undefined, scope),
        typeof target === "string" ? target : target.location,
        create,
      ),
    );
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
  const retainedPrevious = previous && !isRetired(previous) ? previous : undefined;
  if (retainedPrevious) {
    state.registry.observeLocation(location, key);
    state.seals.load(retainedPrevious);
    return;
  }
  // A worker's unmanaged descriptors close on exit and can release sibling SQLite POSIX locks.
  // Core workers borrow host custody through the existing exchange; raw workers keep native checks.
  if (threadId !== 0) {
    return;
  }
  const descriptor = fs.openSync(location, "r");
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
  const retained = state.registry.forLocation(location);
  if (retained) {
    state.seals.load(retained);
    return retained;
  }
  exchange(location);
  const shared = state.registry.forLocation(location);
  if (shared) {
    state.seals.load(shared);
    return shared;
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
    // SQLite also accepts relative filenames and encoded Windows namespaces, not only file URLs.
    const [uriFilename = ""] = filename.slice("file:".length).split(/[?#]/u, 1);
    filename = uriFilename.startsWith("/") ? fileURLToPath(url) : decodeURIComponent(uriFilename);
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
    state.connections.set(database, record);
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
  if (record && !isRetired(record)) {
    state.connections.set(database, record);
  }
  return record && !isRetired(record) ? record : undefined;
}

export function getSqliteDatabaseAdmission<T>(
  database: DatabaseSync,
  key: SqliteDatabaseAdmissionKey<T>,
  options: { existingOnly?: boolean } = {},
): T | undefined {
  if (!database.isOpen || state.suspended.has(database)) {
    return undefined;
  }
  const record = admission(database, options.existingOnly !== true);
  if (!record) {
    return undefined;
  }
  const local =
    getSqliteNativeAdmissionFacts(database)?.get(key.name) ??
    state.local.get(database)?.get(key.name);
  if (
    local &&
    local.revision === readSqliteDatabaseFactRevision(record, local.schemaDependent) &&
    (!local.schemaDependent || local.ddlRevision === (state.ddlRevisions.get(database) ?? 0))
  ) {
    return key.read(local.value);
  }
  if (key.schemaDependent && state.schemaDirty.has(database)) {
    return undefined;
  }
  if (state.rolledBack.has(database)) {
    if (database.isTransaction) {
      return undefined;
    }
    state.rolledBack.delete(database);
  }
  let fact = record.facts.get(key.name);
  if (!fact || !valid(record, fact)) {
    if (key.writer === "host") {
      if (
        database.isTransaction ||
        threadId === 0 ||
        record.hostRevision ===
          Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.hostRevision)
      ) {
        return undefined;
      }
      exchange(record);
      fact = record.facts.get(key.name);
      return fact && valid(record, fact) ? key.read(fact.value) : undefined;
    }
    const revision = Atomics.load(
      new Int32Array(record.generation),
      SqliteDatabaseGenerationSlot.publicationRevision,
    );
    const misses = state.misses.get(record) ?? new Map<string, number>();
    state.misses.set(record, misses);
    if (!database.isTransaction && misses.get(key.name) !== revision) {
      exchange(record);
      fact = record.facts.get(key.name);
      misses.set(
        key.name,
        Atomics.load(
          new Int32Array(record.generation),
          SqliteDatabaseGenerationSlot.publicationRevision,
        ),
      );
    }
  }
  return fact && valid(record, fact) ? key.read(fact.value) : undefined;
}

export function getOrLoadSqliteDatabaseAdmissionForPath<T>(
  location: string,
  key: SqliteDatabaseAdmissionKey<T>,
  load: () => T | undefined,
): T | undefined {
  const record = pathAdmission(location);
  const fact = record?.facts.get(key.name);
  const cached = record && fact && valid(record, fact) ? key.read(fact.value) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const generation = record
    ? readSqliteDatabaseFactRevision(record, key.schemaDependent)
    : undefined;
  const value = load();
  if (record && generation !== undefined && value !== undefined) {
    publishFact(record, key, value, generation);
  }
  return value;
}

function publishFact<T>(
  record: Admission,
  key: Pick<SqliteDatabaseAdmissionKey<T>, "name" | "schemaDependent" | "writer">,
  value: T,
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
  state.dataWriters.set(database, admission(database));
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
    Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.writeRevision, 1);
  }
}

/** Ordinary reads consume the last committed writer revision without a writer census. */
export function readSqliteDatabaseWriteRevision(database: DatabaseSync): number | undefined {
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
  return readWriteRevision(record);
}

/** TEMP-trigger owners already see their own writes and only need sibling settlement. */
export function readSqliteDatabaseSiblingWriteRevision(database: DatabaseSync): number | undefined {
  const revision = readSqliteDatabaseWriteRevision(database);
  return revision === undefined
    ? undefined
    : (revision - (state.localWriteRevisions.get(database) ?? 0)) | 0;
}

/** A stopped worker may have committed before delivering its row-cache receipt. */
export function trackSqliteDatabaseAdmissionWorker(worker: {
  readonly threadId: number;
  once(event: "exit", listener: () => void): unknown;
}): void {
  worker.once("exit", () => {
    for (const record of state.registry.records.values()) {
      Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.writeRevision, 1);
      Atomics.add(
        new Int32Array(record.generation),
        SqliteDatabaseGenerationSlot.unscopedWriteRevision,
        1,
      );
    }
  });
}

export function hasPendingSqliteDatabaseSchemaMutation(database: DatabaseSync): boolean {
  return database.isTransaction && state.schemaDirty.has(database);
}

export function publishSqliteDatabaseAdmission<T>(
  database: DatabaseSync,
  key: SqliteDatabaseAdmissionKey<T>,
  value: T,
  options: { schemaRevision?: number } = {},
): void {
  const record = admission(database);
  if (!record || isRetired(record) || state.suspended.has(database)) {
    return;
  }
  if (key.writer === "host" && threadId !== 0) {
    throw new Error("SQLite host-owned admission facts require the host publisher");
  }
  const revision =
    (key.schemaDependent ? options.schemaRevision : undefined) ??
    readSqliteDatabaseFactRevision(record, key.schemaDependent);
  const native = getSqliteNativeAdmissionFacts(database);
  if (!native && !database.isTransaction) {
    publishFact(record, key, value, revision);
    return;
  }
  const staged: StagedAdmissionFact = {
    value,
    revision,
    schemaDependent: key.schemaDependent === true,
    ddlRevision: state.ddlRevisions.get(database) ?? 0,
  };
  if (native) {
    native.set(key.name, staged);
    return;
  }
  const local = state.local.get(database) ?? new Map<string, StagedAdmissionFact>();
  state.local.set(database, local);
  const previous = local.get(key.name);
  const restore = () => {
    if (state.local.get(database) !== local) {
      return;
    }
    if (previous === undefined) {
      local.delete(key.name);
    } else {
      local.set(key.name, previous);
    }
  };
  stageSqliteTransactionState(database, {
    stage: () => local.set(key.name, staged),
    rollback: restore,
    commit: () => {
      if (state.local.get(database) === local && local.get(key.name) === staged) {
        local.delete(key.name);
        if (
          staged.revision === readSqliteDatabaseFactRevision(record, staged.schemaDependent) &&
          (!staged.schemaDependent ||
            staged.ddlRevision === (state.ddlRevisions.get(database) ?? 0))
        ) {
          publishFact(record, key, value, staged.revision);
        }
      }
    },
  });
}

/** Track uncommitted DDL separately so it cannot revive a receipt validated before a later change. */
export function invalidateLocalSqliteSchemaAdmissions(database: DatabaseSync): void {
  const revision = state.ddlRevisions.get(database) ?? 0;
  const dirty = state.schemaDirty.has(database);
  const stage = () => {
    state.ddlRevisions.set(database, revision + 1);
    state.schemaDirty.add(database);
  };
  if (
    !stageSqliteTransactionState(database, {
      stage,
      commit: () => {},
      rollback: () => {
        state.ddlRevisions.set(database, revision);
        if (!dirty) {
          state.schemaDirty.delete(database);
        }
      },
    })
  ) {
    stage();
  }
}

/** Raw rollback cannot restore staging boundaries; require new facts in any remaining transaction. */
export function discardSqliteDatabaseTransactionAdmissions(database: DatabaseSync): void {
  const record = admission(database, false);
  for (const pending of [getSqliteNativeAdmissionFacts(database), state.local.get(database)]) {
    for (const key of pending?.keys() ?? []) {
      const previous = record?.facts.get(key);
      if (previous) {
        Atomics.store(new Int32Array(previous.current), 0, 0);
      }
    }
    pending?.clear();
  }
  state.local.delete(database);
  state.rolledBack.add(database);
  if (!database.isTransaction) {
    state.schemaDirty.delete(database);
  }
}

/** The DDL owner advances committed format and acknowledges only its final validated receipts. */
export function publishSqliteDatabaseSchemaChange(database: DatabaseSync): void {
  const record = admission(database, false);
  if (record) {
    const previous = Atomics.add(
      new Int32Array(record.generation),
      SqliteDatabaseGenerationSlot.schemaRevision,
      1,
    );
    const ddlRevision = state.ddlRevisions.get(database) ?? 0;
    for (const fact of state.local.get(database)?.values() ?? []) {
      if (fact.schemaDependent && fact.revision === previous && fact.ddlRevision === ddlRevision) {
        fact.revision = previous + 1;
      }
    }
  } else {
    const fileIdentity = state.openedIdentities.get(database);
    if (fileIdentity) {
      // Unhosted threads still share committed schema changes between their own handles.
      state.localSchemaRevisions.set(
        fileIdentity,
        (state.localSchemaRevisions.get(fileIdentity) ?? 0) + 1,
      );
    }
  }
  if (!database.isTransaction) {
    state.schemaDirty.delete(database);
  }
}

export function revokeSqliteDatabaseAdmissions(database: DatabaseSync): void {
  // A close failure can report corruption after native disposal; keep revocation on that file.
  const record = state.connections.get(database) ?? admission(database);
  if (record) {
    state.seals.invalidate(record.location, record);
    const cell = new Int32Array(record.generation);
    Atomics.add(cell, SqliteDatabaseGenerationSlot.schemaRevision, 1);
    Atomics.add(cell, SqliteDatabaseGenerationSlot.factRevision, 1);
    state.local.delete(database);
  }
}

export function revokeSqliteDatabaseAdmissionsForPath(location: string): void {
  const record = pathAdmission(location);
  state.seals.invalidate(location, record);
  if (record) {
    const cell = new Int32Array(record.generation);
    Atomics.add(cell, SqliteDatabaseGenerationSlot.schemaRevision, 1);
    Atomics.add(cell, SqliteDatabaseGenerationSlot.factRevision, 1);
  }
}

/** Explicit removal or maintenance calls this only after its owner has joined native consumers. */
export function retireSqliteDatabaseAdmissionForPath(
  location: string,
  options: { requireSoleDescriptor?: boolean } = {},
): void {
  const observed = prepareSqliteDatabaseAdmission(location);
  if (observed) {
    state.localSchemaRevisions.delete(observed);
  }
  const record = observed ? state.registry.records.get(observed) : undefined;
  if (!record || isRetired(record)) {
    return;
  }
  const file = fs.fstatSync(record.descriptor, { bigint: true });
  if (
    file.nlink > 1n ||
    (options.requireSoleDescriptor && !isSoleDatabaseFileDescriptor(record.descriptor, file))
  ) {
    return;
  }
  const cell = new Int32Array(record.generation);
  if (Atomics.compareExchange(cell, SqliteDatabaseGenerationSlot.retired, 0, 1) === 0) {
    Atomics.add(cell, SqliteDatabaseGenerationSlot.schemaRevision, 1);
    Atomics.add(cell, SqliteDatabaseGenerationSlot.factRevision, 1);
    fs.closeSync(record.descriptor);
  }
  state.registry.records.delete(record.identity);
  state.registry.publish(record);
}

export function getSqliteDatabaseSchemaRevision(database: DatabaseSync): number | undefined {
  const record = admission(database);
  if (record) {
    return Atomics.load(
      new Int32Array(record.generation),
      SqliteDatabaseGenerationSlot.schemaRevision,
    );
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

export function hasSqliteDatabaseSchemaAdmissionForPath(location: string): boolean {
  return hasSqliteDatabaseSchemaAdmission(pathAdmission(location));
}

/** Admission owns the descriptor's immutable identity; callers do not re-stat its pathname. */
export function getSqliteDatabaseAdmissionIdentityForPath(
  location: string,
): DatabaseFileIdentity | undefined {
  return state.registry.forLocation(location)?.physicalIdentity;
}

/** Consume the already captured physical identity without another filesystem lookup. */
export function hasSqliteDatabaseSchemaAdmissionForIdentity(
  physicalIdentity: DatabaseFileIdentity,
): boolean {
  return state.registry.hasSchemaAdmissionForIdentity(physicalIdentity);
}

export function captureSqliteDatabaseAdmissions(
  cursor?: SqliteDatabaseAdmissionCursor,
  scope?: { location?: string; admissions?: SqliteDatabaseAdmissions },
): SqliteDatabaseAdmissions {
  if (!scope) {
    return state.registry.capture(cursor);
  }
  const identities = new Set(scope.admissions?.map((record) => record.identity));
  if (scope.location !== undefined) {
    const observed = state.registry.forLocation(scope.location)?.identity;
    if (observed) {
      identities.add(observed);
    }
  }
  return state.registry.capture(cursor, identities);
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
}
