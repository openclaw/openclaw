// Admission transport and task scope do not need native connection validation or publication logging.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  SqliteDatabaseAdmissionRegistry,
  readSqliteDatabaseAdmissionIdentity,
  isSqliteDatabaseAdmissionRetired,
  readSqliteDatabaseAdmissions,
  type Admission,
  type SqliteDatabaseAdmissionCursor,
  type SqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissionExchange as Exchange,
  type StagedAdmissionFact,
} from "./sqlite-database-admission-record.js";
import { assertDatabaseFileIdentity, type DatabaseFileIdentity } from "./sqlite-worker-identity.js";

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
}));

export { state as sqliteDatabaseAdmissionState };

export function captureSqliteDatabaseAdmissions(
  cursor?: SqliteDatabaseAdmissionCursor,
  scope?: { location?: string; admissions?: readonly Pick<Admission, "identity">[] },
): SqliteDatabaseAdmissions {
  return state.registry.capture(cursor, scope);
}

export function installSqliteDatabaseAdmissions(admissions: SqliteDatabaseAdmissions): void {
  state.registry.install(admissions);
}

export function exchangeSqliteDatabaseAdmission(
  target: string | Admission,
  create?: boolean,
  onlyChanged = false,
): void {
  const current = state.exchange.getStore();
  if (!current || state.exchanging) {
    return;
  }
  state.exchanging = true;
  try {
    const scope = typeof target === "string" ? { location: target } : { admissions: [target] };
    const admissions = state.registry.captureExchange(scope, target);
    if (onlyChanged && admissions.length === 0) {
      return;
    }
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

// Only pending descriptor acquisition is shared; the canonical registry owns its permanent custody.
const pendingDescriptors = new Map<string, Promise<Admission>>();

export async function retainSqliteDatabaseAdmissionDescriptorAsync(
  location: string,
  expectedIdentity?: DatabaseFileIdentity,
): Promise<Admission | undefined> {
  const observed = await fs.promises.stat(location, { bigint: true });
  if (!observed.isFile()) {
    return undefined;
  }
  if (expectedIdentity) {
    assertDatabaseFileIdentity(observed, expectedIdentity);
  }
  const key = readSqliteDatabaseAdmissionIdentity(observed);
  let record = state.registry.records.get(key);
  if (!record || isSqliteDatabaseAdmissionRetired(record)) {
    if (threadId !== 0) {
      return undefined;
    }
    let pending = pendingDescriptors.get(key);
    if (!pending) {
      pending = (async () => {
        const descriptor =
          state.registry.descriptors.get(key)?.descriptor ??
          (await new Promise<number>((resolve, reject) => {
            fs.open(location, "r", (error, openedDescriptor) =>
              error ? reject(error) : resolve(openedDescriptor),
            );
          }));
        // Numeric descriptors remain with registry custody. Closing a temporary FileHandle
        // here could release another connection's POSIX locks.
        const opened = await new Promise<fs.BigIntStats>((resolve, reject) => {
          fs.fstat(descriptor, { bigint: true }, (error, file) =>
            error ? reject(error) : resolve(file),
          );
        });
        if (!opened.isFile() || readSqliteDatabaseAdmissionIdentity(opened) !== key) {
          throw new Error("SQLite database changed while retaining its admission identity");
        }
        const canonicalPath = await fs.promises.realpath(location);
        const current = await fs.promises.stat(canonicalPath, { bigint: true });
        if (!current.isFile() || readSqliteDatabaseAdmissionIdentity(current) !== key) {
          throw new Error("SQLite database changed while retaining its admission identity");
        }
        const custody = state.registry.descriptors.get(key);
        if (custody && custody.descriptor !== descriptor) {
          // Native admission may win while filesystem work awaits. Closing the extra
          // descriptor now could drop its SQLite locks; the joined owner retires both.
          (custody.additionalDescriptors ??= new Set()).add(descriptor);
        }
        const currentRecord = state.registry.records.get(key);
        return currentRecord && !isSqliteDatabaseAdmissionRetired(currentRecord)
          ? currentRecord
          : state.registry.retainDescriptor(
              canonicalPath,
              custody?.descriptor ?? descriptor,
              opened,
            );
      })();
      pendingDescriptors.set(key, pending);
      void pending
        .finally(() => {
          if (pendingDescriptors.get(key) === pending) {
            pendingDescriptors.delete(key);
          }
        })
        .catch(() => undefined);
    }
    record = await pending;
  }
  state.registry.observeLocation(location, record.identity);
  return record;
}
