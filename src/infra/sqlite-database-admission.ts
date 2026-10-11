import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
  type SqliteDatabaseAdmissionCursor,
  SQLITE_DATABASE_GENERATION_LENGTH,
  readSqliteDatabaseAdmissions,
  readSqliteDatabaseFactRevision,
  activeSqliteDatabaseWriters as activeWriters,
  readSqliteDatabaseRecordWriteRevision as readWriteRevision,
  retireSqliteDatabaseWriter,
  ensureSqliteDatabaseWriter,
  publishSqliteDatabaseFact,
  isSqliteDatabaseAdmissionRetired as isRetired,
  isSqliteDatabaseAdmissionFactCurrent as valid,
  type Admission,
  type SqliteDatabaseAdmissions,
  type StagedAdmissionFact,
} from "./sqlite-database-admission-record.js";
import {
  getSqliteNativeAdmissionFacts,
  hasSqliteNativeAdmissionOperation,
} from "./sqlite-native-admission.js";
import { hasSqlitePostCommitScope, stageSqliteTransactionState } from "./sqlite-post-commit.js";
import {
  isSoleDatabaseFileDescriptor,
  readDatabaseIdentityBirthtime,
} from "./sqlite-worker-identity.js";

export {
  readSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  type SqliteDatabaseAdmissionCursor,
} from "./sqlite-database-admission-record.js";
export type { SqliteDatabaseAdmissions } from "./sqlite-database-admission-record.js";
export { beginSqliteDatabaseAdmissionOperation } from "./sqlite-native-admission.js";

export type SqliteDatabaseAdmissionKey<T> = {
  name: string;
  read(this: void, value: unknown): T | undefined;
  schemaDependent?: boolean;
  writer?: "host";
};

type Exchange = (
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean,
) => SqliteDatabaseAdmissions;

const state = resolveGlobalSingleton(Symbol.for("openclaw.sqliteDatabaseAdmissions"), () => ({
  registry: new SqliteDatabaseAdmissionRegistry(),
  connections: new WeakMap<DatabaseSync, Admission>(),
  openedIdentities: new WeakMap<DatabaseSync, string>(),
  unproven: new WeakSet<DatabaseSync>(),
  suspended: new WeakSet<DatabaseSync>(),
  local: new WeakMap<DatabaseSync, Map<string, StagedAdmissionFact>>(),
  rolledBack: new WeakSet<DatabaseSync>(),
  schemaWriters: new WeakMap<DatabaseSync, Admission>(),
  dataWriters: new WeakMap<DatabaseSync, Admission | undefined>(),
  localWriteRevisions: new WeakMap<DatabaseSync, number>(),
  ddlRevisions: new WeakMap<DatabaseSync, number>(),
  schemaDirty: new WeakSet<DatabaseSync>(),
  misses: new WeakMap<Admission, Map<string, number>>(),
  exchange: new AsyncLocalStorage<Exchange>(),
  exchanging: false,
  publication: 0,
}));

function identity(file: fs.BigIntStats): string {
  return `${file.dev}:${file.ino}:${readDatabaseIdentityBirthtime(file)}`;
}

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

function retainDescriptor(location: string, descriptor: number, opened: fs.BigIntStats): Admission {
  const record: Admission = {
    identity: identity(opened),
    location,
    descriptor,
    descriptorOwner: 0,
    generationId: randomUUID(),
    generation: new SharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT * SQLITE_DATABASE_GENERATION_LENGTH,
    ),
    writers: new Map(),
    facts: new Map(),
  };
  state.registry.records.set(record.identity, record);
  state.registry.publish(record);
  return record;
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
    const retained = fs.fstatSync(retainedPrevious.descriptor, { bigint: true });
    if (identity(retained) === key) {
      return;
    }
    throw new Error("SQLite retained admission descriptor changed identity");
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
  retainDescriptor(location, descriptor, opened);
}

function pathAdmission(location: string): Admission | undefined {
  exchange(location);
  try {
    retainSqliteDatabaseAdmissionLocation(location);
    return state.registry.records.get(identity(fs.statSync(location, { bigint: true })));
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
    return file.isFile() ? identity(file) : undefined;
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
      const record = retainDescriptor(filename, descriptor, opened);
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
  if (expected === undefined) {
    // Unhosted raw workers cannot prove which file SQLite created; never lend that handle's facts.
    state.unproven.add(database);
    return;
  }
  state.openedIdentities.set(database, observed);
  const record = state.registry.records.get(observed);
  if (record && !isRetired(record)) {
    // Existing admission is checked with fstat before the new native connection borrows it.
    retainSqliteDatabaseAdmissionLocation(location);
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
  const record = create ? pathAdmission(location) : state.registry.records.get(expected);
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
  if (!record || (key.schemaDependent && hasForeignSchemaWriter(database, record))) {
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
    if (misses.get(key.name) !== revision) {
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
  const pendingSchema = record && key.schemaDependent && activeWriters(record, 0, exchange) !== 0;
  const cached =
    record && fact && !pendingSchema && valid(record, fact) ? key.read(fact.value) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const generation = record
    ? readSqliteDatabaseFactRevision(record, key.schemaDependent)
    : undefined;
  const value = load();
  if (record && generation !== undefined && value !== undefined) {
    if (
      identity(fs.statSync(location, { bigint: true })) !== record.identity ||
      generation !== readSqliteDatabaseFactRevision(record, key.schemaDependent)
    ) {
      throw new Error("SQLite database changed while loading admission facts");
    }
    if (
      !hasNativeAdmissionOperation(record) &&
      !(key.schemaDependent && activeWriters(record, 0, exchange) !== 0)
    ) {
      publishFact(record, key, value, generation);
    }
  }
  return value;
}

function publishFact<T>(
  record: Admission,
  key: SqliteDatabaseAdmissionKey<T>,
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

function hasNativeAdmissionOperation(record: Admission): boolean {
  return hasSqliteNativeAdmissionOperation((database) => admission(database, false) === record);
}

function hasForeignSchemaWriter(database: DatabaseSync, record: Admission): boolean {
  const active = activeWriters(record, 0, exchange);
  return active === undefined || active > (state.schemaWriters.get(database) === record ? 1 : 0);
}

/** The native commit and its catalog publication are one shared admission boundary. */
export function beginSqliteDatabaseSchemaMutation(database: DatabaseSync): void {
  if (state.schemaWriters.has(database)) {
    return;
  }
  const record = prepareSqliteDatabaseWriter(database);
  if (record) {
    state.schemaWriters.set(database, record);
    Atomics.add(new Int32Array(record.writers.get(threadId)!.cell), 0, 1);
  }
}

/** Writable transaction entry establishes custody before taking SQLite locks. */
export function prepareSqliteDatabaseWriter(database: DatabaseSync): Admission | undefined {
  // Cold host and managed worker DDL need custody before any native callback can admit a sibling.
  const record = admission(database, threadId === 0 || state.exchange.getStore() !== undefined);
  if (record) {
    if (threadId !== 0 && state.exchange.getStore() === undefined) {
      // Unmanaged native writers have no host that can settle their custody on exit.
      state.unproven.add(database);
      return undefined;
    }
    ensureSqliteDatabaseWriter(record, () => {
      state.registry.publish(record);
      exchange(record);
    });
  }
  return record;
}

/** Fence native writes through their transaction or implicit-cursor settlement. */
export function beginSqliteDatabaseWrite(database: DatabaseSync): void {
  if (state.dataWriters.has(database)) {
    return;
  }
  const record = prepareSqliteDatabaseWriter(database);
  state.dataWriters.set(database, record);
  if (record) {
    Atomics.add(new Int32Array(record.writers.get(threadId)!.cell), 2, 1);
  }
}

/** Native settlement publishes before releasing the fence, including uncertain outcomes. */
export function finishSqliteDatabaseWrite(database: DatabaseSync): void {
  if (!state.dataWriters.has(database)) {
    return;
  }
  const record = state.dataWriters.get(database);
  state.dataWriters.delete(database);
  state.localWriteRevisions.set(database, (state.localWriteRevisions.get(database) ?? 0) + 1);
  if (record) {
    Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.writeRevision, 1);
    Atomics.sub(new Int32Array(record.writers.get(threadId)!.cell), 2, 1);
  }
}

/** A receipt revision is reusable only while no sibling can be publishing a native commit. */
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
  return readWriteRevision(record, state.dataWriters.get(database) === record ? 1 : 0, exchange);
}

/** Host row caches retain a physical identity and receipt without opening SQLite. */
export function readSqliteDatabaseWriteTokenForPath(location: string): string | undefined {
  const record = pathAdmission(location);
  if (!record || isRetired(record)) {
    return undefined;
  }
  const revision = readWriteRevision(record, 0, exchange);
  return revision === undefined ? undefined : `${record.identity}:${revision}`;
}

/** The managed writer's next settlement advances its physical revision exactly once. */
export function readSqliteDatabasePendingWriteToken(database: DatabaseSync): string | undefined {
  if (
    !database.isOpen ||
    !database.isTransaction ||
    !hasSqlitePostCommitScope(database) ||
    state.suspended.has(database)
  ) {
    return undefined;
  }
  const record = state.dataWriters.get(database);
  if (!record || isRetired(record)) {
    return undefined;
  }
  const revision = readWriteRevision(record, 1, exchange);
  return revision === undefined ? undefined : `${record.identity}:${(revision + 1) | 0}`;
}

/** TEMP-trigger owners already see their own writes and only need sibling settlement. */
export function readSqliteDatabaseSiblingWriteRevision(database: DatabaseSync): number | undefined {
  const revision = readSqliteDatabaseWriteRevision(database);
  return revision === undefined
    ? undefined
    : (revision - (state.localWriteRevisions.get(database) ?? 0)) | 0;
}

export function finishSqliteDatabaseSchemaMutation(database: DatabaseSync): void {
  const record = state.schemaWriters.get(database);
  if (record) {
    if (!database.isOpen) {
      // Close can follow a committed callback statement before its catalog was published.
      Atomics.add(
        new Int32Array(record.generation),
        SqliteDatabaseGenerationSlot.schemaRevision,
        1,
      );
    }
    state.schemaWriters.delete(database);
    const custody = record.writers.get(threadId);
    if (custody) {
      Atomics.sub(new Int32Array(custody.cell), 0, 1);
    }
  }
}

/** Confirmed native exit joins SQLite resources before another worker can trust its catalog. */
export function trackSqliteDatabaseAdmissionWorker(worker: {
  readonly threadId: number;
  once(event: "exit", listener: () => void): unknown;
}): void {
  const id = worker.threadId;
  worker.once("exit", () => {
    for (const record of state.registry.records.values()) {
      retireSqliteDatabaseWriter(record, id);
    }
  });
}

export function hasPendingSqliteDatabaseSchemaMutation(database: DatabaseSync): boolean {
  const record = admission(database, false);
  return Boolean(record && hasForeignSchemaWriter(database, record));
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
  if (
    key.schemaDependent &&
    (hasForeignSchemaWriter(database, record) ||
      revision !==
        Atomics.load(
          new Int32Array(record.generation),
          SqliteDatabaseGenerationSlot.schemaRevision,
        ))
  ) {
    return;
  }
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
  }
  if (!database.isTransaction) {
    state.schemaDirty.delete(database);
  }
}

export function revokeSqliteDatabaseAdmissions(database: DatabaseSync): void {
  // A close failure can report corruption after native disposal; keep revocation on that file.
  const record = state.connections.get(database) ?? admission(database);
  if (record) {
    const cell = new Int32Array(record.generation);
    Atomics.add(cell, SqliteDatabaseGenerationSlot.schemaRevision, 1);
    Atomics.add(cell, SqliteDatabaseGenerationSlot.factRevision, 1);
    state.local.delete(database);
  }
}

export function revokeSqliteDatabaseAdmissionsForPath(location: string): void {
  const record = pathAdmission(location);
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
  return record
    ? Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.schemaRevision)
    : undefined;
}

export function suspendSqliteDatabaseAdmission(database: DatabaseSync, suspended: boolean): void {
  if (suspended) {
    state.suspended.add(database);
  } else {
    state.suspended.delete(database);
  }
}

export function hasSqliteDatabaseSchemaAdmissionForPath(location: string): boolean {
  const record = pathAdmission(location);
  const fact = record?.facts.get("sqlite-schema");
  return Boolean(record && fact && valid(record, fact));
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
    const observed = prepareSqliteDatabaseAdmission(scope.location);
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
