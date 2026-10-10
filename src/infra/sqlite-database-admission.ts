import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getEnvironmentData, setEnvironmentData, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasErrnoCode } from "./errno.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  readSqliteDatabaseAdmissions,
  registerWriterCustody,
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
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import {
  isSoleDatabaseFileDescriptor,
  readDatabaseIdentityBirthtime,
} from "./sqlite-worker-identity.js";
import { workerAncestors } from "./worker-ancestry.js";

export { readSqliteDatabaseAdmissions } from "./sqlite-database-admission-record.js";
export type { SqliteDatabaseAdmissions } from "./sqlite-database-admission-record.js";
export { beginSqliteDatabaseAdmissionOperation } from "./sqlite-native-admission.js";

export type SqliteDatabaseAdmissionKey<T> = {
  name: string;
  read(this: void, value: unknown): T | undefined;
  schemaDependent?: boolean;
};

export type SqliteDatabaseAdmissionCursor = Map<string, string>;
type Exchange = (
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean,
) => SqliteDatabaseAdmissions;

const state = resolveGlobalSingleton(Symbol.for("openclaw.sqliteDatabaseAdmissions"), () => ({
  admissions: new Map<string, Admission>(),
  connections: new WeakMap<DatabaseSync, Admission>(),
  openedIdentities: new WeakMap<DatabaseSync, string>(),
  unproven: new WeakSet<DatabaseSync>(),
  suspended: new WeakSet<DatabaseSync>(),
  local: new WeakMap<DatabaseSync, Map<string, StagedAdmissionFact>>(),
  rolledBack: new WeakSet<DatabaseSync>(),
  schemaWriters: new WeakMap<DatabaseSync, Admission>(),
  ddlRevisions: new WeakMap<DatabaseSync, number>(),
  schemaDirty: new WeakSet<DatabaseSync>(),
  misses: new WeakMap<Admission, Map<string, number>>(),
  sent: new Map<string, string>(),
  exchange: new AsyncLocalStorage<Exchange>(),
  exchanging: false,
  publication: 0,
}));

function identity(file: fs.BigIntStats): string {
  return `${file.dev}:${file.ino}:${readDatabaseIdentityBirthtime(file)}`;
}

function rememberEnvironment(): void {
  setEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY, captureSqliteDatabaseAdmissions());
}

function exchange(location?: string, create?: boolean): void {
  const current = state.exchange.getStore();
  if (!current || state.exchanging) {
    return;
  }
  state.exchanging = true;
  try {
    installSqliteDatabaseAdmissions(
      current(captureSqliteDatabaseAdmissions(state.sent), location, create),
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
    generation: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5),
    writers: new Map(),
    facts: new Map(),
  };
  state.admissions.set(record.identity, record);
  rememberEnvironment();
  return record;
}

/** Identity descriptors stay open for the process: closing one can release SQLite's POSIX locks. */
export function retainSqliteDatabaseAdmissionLocation(location: string): void {
  const observed = fs.statSync(location, { bigint: true });
  if (!observed.isFile()) {
    return;
  }
  const key = identity(observed);
  const previous = state.admissions.get(key);
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
    return state.admissions.get(identity(fs.statSync(location, { bigint: true })));
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
  const record = state.admissions.get(observed);
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
  const record = create ? pathAdmission(location) : state.admissions.get(expected);
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
  if (key.schemaDependent && hasForeignSchemaWriter(database, record)) {
    return undefined;
  }
  const local =
    getSqliteNativeAdmissionFacts(database)?.get(key.name) ??
    state.local.get(database)?.get(key.name);
  if (
    local &&
    local.revision ===
      Atomics.load(new Int32Array(record.generation), local.schemaDependent ? 0 : 1) &&
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
    const revision = Atomics.load(new Int32Array(record.generation), 2);
    const misses = state.misses.get(record) ?? new Map<string, number>();
    state.misses.set(record, misses);
    if (misses.get(key.name) !== revision) {
      exchange(record.location);
      fact = record.facts.get(key.name);
      misses.set(key.name, Atomics.load(new Int32Array(record.generation), 2));
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
  const pendingSchema = record && key.schemaDependent && activeSchemaWriters(record) !== 0;
  const cached =
    record && fact && !pendingSchema && valid(record, fact) ? key.read(fact.value) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const generation = record
    ? Atomics.load(new Int32Array(record.generation), key.schemaDependent ? 0 : 1)
    : undefined;
  const value = load();
  if (record && generation !== undefined && value !== undefined) {
    if (
      identity(fs.statSync(location, { bigint: true })) !== record.identity ||
      generation !== Atomics.load(new Int32Array(record.generation), key.schemaDependent ? 0 : 1)
    ) {
      throw new Error("SQLite database changed while loading admission facts");
    }
    if (
      !hasNativeAdmissionOperation(record) &&
      !(key.schemaDependent && activeSchemaWriters(record) !== 0)
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
  if (revision !== Atomics.load(new Int32Array(record.generation), key.schemaDependent ? 0 : 1)) {
    return;
  }
  const previous = record.facts.get(key.name);
  if (previous) {
    Atomics.store(new Int32Array(previous.current), 0, 0);
  }
  const current = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(current), 0, 1);
  record.facts.set(key.name, {
    value,
    revision,
    schemaDependent: key.schemaDependent === true,
    publication: `${threadId}:${++state.publication}`,
    current,
  });
  Atomics.add(new Int32Array(record.generation), 2, 1);
  rememberEnvironment();
  exchange();
}

function hasNativeAdmissionOperation(record: Admission): boolean {
  return hasSqliteNativeAdmissionOperation((database) => admission(database, false) === record);
}

function activeSchemaWriters(record: Admission): number | undefined {
  const known = () =>
    [...record.writers.values()].filter(({ cell }) => Atomics.load(new Int32Array(cell), 1) === 1)
      .length;
  if (known() < Atomics.load(new Int32Array(record.generation), 4)) {
    exchange(record.location);
    if (known() < Atomics.load(new Int32Array(record.generation), 4)) {
      return undefined;
    }
  }
  let active = 0;
  for (const { cell } of record.writers.values()) {
    active += Atomics.load(new Int32Array(cell), 0);
  }
  return active;
}

function hasForeignSchemaWriter(database: DatabaseSync, record: Admission): boolean {
  const active = activeSchemaWriters(record);
  return active === undefined || active > (state.schemaWriters.get(database) === record ? 1 : 0);
}

/** The native commit and its catalog publication are one shared admission boundary. */
export function beginSqliteDatabaseSchemaMutation(database: DatabaseSync): void {
  if (state.schemaWriters.has(database)) {
    return;
  }
  // Cold host and managed worker DDL need custody before any native callback can admit a sibling.
  const record = admission(database, threadId === 0 || state.exchange.getStore() !== undefined);
  if (record) {
    if (threadId !== 0 && state.exchange.getStore() === undefined) {
      // Unmanaged native writers have no host that can settle their custody on exit.
      state.unproven.add(database);
      return;
    }
    let custody = record.writers.get(threadId);
    if (!custody) {
      custody = {
        cell: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
        ancestors: workerAncestors,
      };
      record.writers.set(threadId, custody);
    }
    const { cell } = custody;
    if (Atomics.load(new Int32Array(cell), 1) === 0) {
      registerWriterCustody(record);
      // Publish custody before native work starts, so an exit can retire this cell.
      rememberEnvironment();
      exchange();
      if (Atomics.load(new Int32Array(cell), 1) === 0) {
        throw new Error("SQLite schema mutation requires host custody");
      }
    }
    state.schemaWriters.set(database, record);
    Atomics.add(new Int32Array(cell), 0, 1);
  }
}

export function finishSqliteDatabaseSchemaMutation(database: DatabaseSync): void {
  const record = state.schemaWriters.get(database);
  if (record) {
    if (!database.isOpen) {
      // Close can follow a committed callback statement before its catalog was published.
      Atomics.add(new Int32Array(record.generation), 0, 1);
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
    for (const record of state.admissions.values()) {
      const joined: Int32Array[] = [];
      for (const [writer, { cell, ancestors }] of record.writers) {
        if (writer === id || ancestors.includes(id)) {
          joined.push(new Int32Array(cell));
        }
      }
      if (joined.some((cell) => Atomics.load(cell, 0) > 0)) {
        // Native parent exit also joins descendants whose JS exit listeners cannot run.
        // Revoke possibly unpublished commits before releasing their shared writer fence.
        Atomics.add(new Int32Array(record.generation), 0, 1);
        for (const cell of joined) {
          Atomics.store(cell, 0, 0);
        }
      }
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
  const revision =
    (key.schemaDependent ? options.schemaRevision : undefined) ??
    Atomics.load(new Int32Array(record.generation), key.schemaDependent ? 0 : 1);
  if (
    key.schemaDependent &&
    (hasForeignSchemaWriter(database, record) ||
      revision !== Atomics.load(new Int32Array(record.generation), 0))
  ) {
    return;
  }
  const publish = (publishedRevision = revision) =>
    publishFact(record, key, value, publishedRevision);
  const native = getSqliteNativeAdmissionFacts(database);
  if (native) {
    native.set(key.name, {
      value,
      revision,
      schemaDependent: key.schemaDependent === true,
      ddlRevision: state.ddlRevisions.get(database) ?? 0,
    });
    return;
  }
  if (!database.isTransaction) {
    publish();
    return;
  }
  const local = state.local.get(database) ?? new Map<string, StagedAdmissionFact>();
  state.local.set(database, local);
  const previous = local.get(key.name);
  const staged: StagedAdmissionFact = {
    value,
    revision,
    schemaDependent: key.schemaDependent === true,
    ddlRevision: state.ddlRevisions.get(database) ?? 0,
  };
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
          staged.revision ===
            Atomics.load(new Int32Array(record.generation), staged.schemaDependent ? 0 : 1) &&
          (!staged.schemaDependent ||
            staged.ddlRevision === (state.ddlRevisions.get(database) ?? 0))
        ) {
          publish(staged.revision);
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
    const previous = Atomics.add(new Int32Array(record.generation), 0, 1);
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
    Atomics.add(cell, 0, 1);
    Atomics.add(cell, 1, 1);
    state.local.delete(database);
  }
}

export function revokeSqliteDatabaseAdmissionsForPath(location: string): void {
  const record = pathAdmission(location);
  if (record) {
    const cell = new Int32Array(record.generation);
    Atomics.add(cell, 0, 1);
    Atomics.add(cell, 1, 1);
  }
}

/** Explicit removal or maintenance calls this only after its owner has joined native consumers. */
export function retireSqliteDatabaseAdmissionForPath(
  location: string,
  options: { requireSoleDescriptor?: boolean } = {},
): void {
  const observed = prepareSqliteDatabaseAdmission(location);
  const record = observed ? state.admissions.get(observed) : undefined;
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
  if (Atomics.compareExchange(cell, 3, 0, 1) === 0) {
    Atomics.add(cell, 0, 1);
    Atomics.add(cell, 1, 1);
    fs.closeSync(record.descriptor);
  }
  state.admissions.delete(record.identity);
  rememberEnvironment();
}

export function getSqliteDatabaseSchemaRevision(database: DatabaseSync): number | undefined {
  const record = admission(database);
  return record ? Atomics.load(new Int32Array(record.generation), 0) : undefined;
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

export function createSqliteDatabaseAdmissionCursor(): SqliteDatabaseAdmissionCursor {
  return new Map();
}

export function captureSqliteDatabaseAdmissions(
  cursor?: SqliteDatabaseAdmissionCursor,
): SqliteDatabaseAdmissions {
  const result: SqliteDatabaseAdmissions = [];
  for (const record of state.admissions.values()) {
    if (isRetired(record)) {
      state.admissions.delete(record.identity);
      continue;
    }
    const facts = new Map([...record.facts].filter(([, fact]) => valid(record, fact)));
    if (cursor) {
      const cell = new Int32Array(record.generation);
      // A reused inode starts a new custody generation even when its counters match.
      const revision = `${record.generationId}:${Atomics.load(cell, 0)}:${Atomics.load(cell, 1)}:${Atomics.load(cell, 4)}:${[...record.writers.keys()].join(",")}:${[...facts.values()].map((fact) => fact.publication).join(",")}`;
      if (cursor.get(record.identity) === revision) {
        continue;
      }
      cursor.set(record.identity, revision);
    }
    result.push({ ...record, facts });
  }
  return result;
}

export function installSqliteDatabaseAdmissions(admissions: SqliteDatabaseAdmissions): void {
  for (const incoming of admissions) {
    if (incoming.descriptorOwner !== 0 || isRetired(incoming)) {
      continue;
    }
    let record = state.admissions.get(incoming.identity);
    if (record && isRetired(record)) {
      state.admissions.delete(record.identity);
      record = undefined;
    }
    if (!record) {
      state.admissions.set(incoming.identity, incoming);
      record = incoming;
    } else if (record.generationId !== incoming.generationId) {
      // Only the host creates a generation; unrelated revocation cells cannot certify its facts.
      continue;
    }
    for (const [key, fact] of incoming.facts) {
      if (valid(incoming, fact)) {
        record.facts.set(key, fact);
      }
    }
    for (const [writer, cell] of incoming.writers) {
      if (!record.writers.has(writer)) {
        record.writers.set(writer, cell);
      }
    }
    registerWriterCustody(record);
  }
  rememberEnvironment();
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
