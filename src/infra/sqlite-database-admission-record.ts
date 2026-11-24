import type { BigIntStats } from "node:fs";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SqliteCleanCloseSealRefusal } from "./sqlite-clean-close-seal.js";
import {
  isSqliteDescriptorCustodyOpen,
  type SqliteDescriptorCustody,
} from "./sqlite-descriptor-custody.js";
import {
  readDatabaseIdentityBirthtime,
  type DatabaseFileIdentity,
} from "./sqlite-worker-identity.js";

export function readSqliteDatabaseAdmissionIdentity(file: BigIntStats): string {
  return `${file.dev}:${file.ino}:${readDatabaseIdentityBirthtime(file)}`;
}

export const SqliteDatabaseGenerationSlot = {
  schemaRevision: 0,
  factRevision: 1,
  publicationRevision: 2,
  retired: 3,
  writeRevision: 4,
  hostRevision: 5,
  unscopedWriteRevision: 6,
  writeScopeRevision: 7,
  sealPresent: 8,
} as const;
export const SQLITE_DATABASE_GENERATION_LENGTH = Object.keys(SqliteDatabaseGenerationSlot).length;

const decodedValue = Symbol.for("openclaw.sqliteDatabaseAdmission.decodedValue");

export type AdmissionFactValue = {
  value: unknown;
  // Structured cloning drops symbol properties, so each receiver admits the wire value once.
  [decodedValue]?: { value: unknown };
};

export function readSqliteDatabaseAdmissionFact<T>(
  fact: AdmissionFactValue,
  key: SqliteDatabaseFactKey<T>,
): T | undefined {
  fact[decodedValue] ??= { value: key.read ? key.read(fact.value) : fact.value };
  // SAFETY: Each key names its typed publisher's value; boundary keys retain their decoder.
  return fact[decodedValue].value as T | undefined;
}

export function admitSqliteDatabaseFactValue<T>(
  key: SqliteDatabaseFactKey<T>,
  value: T,
): AdmissionFactValue {
  const fact: AdmissionFactValue = { value };
  readSqliteDatabaseAdmissionFact(fact, key);
  return fact;
}

export type AdmissionFact = AdmissionFactValue & {
  revision: number;
  schemaDependent: boolean;
  lifetime?: "process";
  publication: string;
  current: SharedArrayBuffer;
};
export type StagedAdmissionFact = AdmissionFactValue &
  Pick<AdmissionFact, "revision" | "schemaDependent"> & {
    ddlRevision: number;
  };
export type ScopedWriteRevision = {
  identity: string;
  // Revision, retirement, and active effect pins share custody across admission snapshots.
  state: Int32Array<SharedArrayBuffer>;
};

const MAX_WRITE_SCOPE_BYTES = 1024 * 1024;
const scopeRetention = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseWriteScopeRetention"),
  () => new WeakMap<Map<string, ScopedWriteRevision>, { bytes: number; retired: Set<string> }>(),
);
// Account for UTF-16 keys plus the UUID, shared cell, and map/snapshot entries.
const writeScopeBytes = (key: string) => key.length * 2 + 256;

/** Idle receipts cache freshness; active effect guards retain their exact shared cells. */
export function retainSqliteDatabaseWriteScope(
  record: Admission,
  key: string,
  revision: ScopedWriteRevision,
): void {
  const scopes = record.writeScopes;
  let retention = scopeRetention.get(scopes);
  if (!retention) {
    retention = {
      bytes: [...scopes.keys()].reduce((bytes, scopeKey) => bytes + writeScopeBytes(scopeKey), 0),
      retired: new Set(),
    };
    scopeRetention.set(scopes, retention);
  }
  if (!scopes.delete(key)) {
    retention.bytes += writeScopeBytes(key);
  }
  scopes.set(key, revision);
  pruneSqliteDatabaseWriteScopes(record);
}

/** Active effect scopes may exceed the idle budget until their final release. */
export function pruneSqliteDatabaseWriteScopes(record: Admission): boolean {
  const retention = scopeRetention.get(record.writeScopes)!;
  if (retention.bytes <= MAX_WRITE_SCOPE_BYTES) {
    return false;
  }
  let changed = false;
  for (const [oldest, value] of record.writeScopes) {
    // Claim an unpinned cell before another isolate can retain it for an effect.
    const pins = Atomics.compareExchange(value.state, 2, 0, -1);
    if (pins > 0 && Atomics.load(value.state, 1) === 0) {
      continue;
    }
    Atomics.store(value.state, 1, 1);
    // A writer missing this cell must fence receipts registered after its dispatch.
    advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
    record.writeScopes.delete(oldest);
    retention.bytes -= writeScopeBytes(oldest);
    retention.retired.add(oldest);
    changed = true;
    if (retention.bytes <= MAX_WRITE_SCOPE_BYTES) {
      break;
    }
  }
  return changed;
}

export type Admission = {
  identity: string;
  physicalIdentity: DatabaseFileIdentity;
  location: string;
  descriptor: number;
  descriptorOwner: number;
  descriptorCustody: SqliteDescriptorCustody;
  generationId: string;
  generation: SharedArrayBuffer;
  /** Bounded, process-local diagnostics only; never consulted for admission. */
  writerDiagnostic: Int32Array<SharedArrayBuffer>;
  /** First-load diagnostic, shared with workers without rereading the seal. */
  cleanCloseRefusal?: SqliteCleanCloseSealRefusal;
  /** Last complete host snapshot; relays preserve this value without advancing it. */
  hostRevision?: number;
  writeScopes: Map<string, ScopedWriteRevision>;
  writeScopeRevision: number;
  /** Each worker shares its handle count and unsettled native-write count. */
  references: Map<number, SharedArrayBuffer>;
  facts: Map<string, AdmissionFact>;
};
export type AdmissionSnapshot = Omit<Admission, "writeScopes"> & { writeScopes: WriteScopeBuckets };
export type SqliteDatabaseAdmissions = AdmissionSnapshot[];
export type AdmissionPublications = Map<Admission, string[] | undefined>;
export type SqliteDatabaseAdmissionKey<T> = {
  name: string;
  read(this: void, value: unknown): T | undefined;
  schemaDependent?: boolean;
  /** Physical validation and owner-published decisions survive ordinary native close. */
  lifetime?: "process";
  /** Physical cache facts can be recaptured locally; their transport never gates a live connection. */
  writer?: "host" | "connection";
};
export type SqliteDatabaseAdmissionLocation = { identity: string; canonicalPath: string };
export type SqliteDatabaseAdmissionExchange = (
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean,
  observedLocation?: SqliteDatabaseAdmissionLocation,
) => SqliteDatabaseAdmissions;

/** Internal typed publications need no decoder; public/custom keys retain their read contract. */
export type SqliteDatabaseFactKey<T> = Omit<SqliteDatabaseAdmissionKey<T>, "read"> & {
  read?: SqliteDatabaseAdmissionKey<T>["read"];
};

export function readSqliteDatabaseAdmissions(value: unknown): SqliteDatabaseAdmissions | undefined {
  // SAFETY: These facts come only from this process's paired worker and bootstrap transports.
  return Array.isArray(value) ? (value as SqliteDatabaseAdmissions) : undefined;
}

export function isSqliteDatabaseAdmissionRetired(
  record: Pick<Admission, "generation" | "descriptorCustody">,
): boolean {
  return (
    readSqliteDatabaseGeneration(record, "retired") !== 0 ||
    !isSqliteDescriptorCustodyOpen(record.descriptorCustody)
  );
}

export function isSqliteDatabaseAdmissionFactCurrent(
  record: Pick<Admission, "generation" | "descriptorCustody">,
  fact: AdmissionFact,
): boolean {
  return (
    !isSqliteDatabaseAdmissionRetired(record) &&
    Atomics.load(new Int32Array(fact.current), 0) === 1 &&
    fact.revision === readSqliteDatabaseFactRevision(record, fact.schemaDependent)
  );
}

export function hasSqliteDatabaseSchemaAdmission(record: Admission | undefined): boolean {
  const fact = record?.facts.get("sqlite-schema");
  return Boolean(record && fact && isSqliteDatabaseAdmissionFactCurrent(record, fact));
}

export function readSqliteDatabaseFactRevision(
  record: Pick<Admission, "generation">,
  schemaDependent: boolean | undefined,
): number {
  return readSqliteDatabaseGeneration(record, schemaDependent ? "schemaRevision" : "factRevision");
}

export function readSqliteDatabaseGeneration(
  record: Pick<Admission, "generation">,
  slot: keyof typeof SqliteDatabaseGenerationSlot,
): number {
  return Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot[slot]);
}
export function advanceSqliteDatabaseGeneration(
  record: Admission,
  slot: keyof typeof SqliteDatabaseGenerationSlot,
): number {
  return Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot[slot], 1);
}
export function publishSqliteDatabaseFact(
  record: Admission,
  key: Pick<
    SqliteDatabaseAdmissionKey<unknown>,
    "name" | "schemaDependent" | "lifetime" | "writer"
  >,
  value: AdmissionFactValue,
  revision: number,
  publication: string,
): boolean {
  if (
    isSqliteDatabaseAdmissionRetired(record) ||
    revision !== readSqliteDatabaseFactRevision(record, key.schemaDependent)
  ) {
    return false;
  }
  if (key.writer === "host") {
    // Missing-key consumers must stop reusing absence before the postimage replaces it.
    advanceSqliteDatabaseGeneration(record, "hostRevision");
  }
  const previous = record.facts.get(key.name);
  if (previous) {
    Atomics.store(new Int32Array(previous.current), 0, 0);
  }
  const current = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(current), 0, 1);
  record.facts.set(key.name, {
    ...value,
    revision,
    schemaDependent: key.schemaDependent === true,
    lifetime: key.lifetime,
    publication,
    current,
  });
  advanceSqliteDatabaseGeneration(record, "publicationRevision");
  return true;
}

export function revokeSqliteDatabaseAdmissionFacts(record: Admission | undefined): void {
  if (!record) {
    return;
  }
  // Corruption can follow native close; shared cells also revoke retained physical facts.
  for (const fact of record.facts.values()) {
    Atomics.store(new Int32Array(fact.current), 0, 0);
  }
  advanceSqliteDatabaseGeneration(record, "schemaRevision");
  advanceSqliteDatabaseGeneration(record, "factRevision");
}

// Bucket snapshots bound copy-on-write work without retaining a history of revisions.
const EMPTY_WRITE_SCOPE_BUCKETS = Array.from(
  { length: 128 },
  () => new Map<string, ScopedWriteRevision>(),
);
type WriteScopeBuckets = typeof EMPTY_WRITE_SCOPE_BUCKETS;
export type PublishedAdmission = {
  metadata: Omit<Admission, "writeScopes">;
  writeScopes: WriteScopeBuckets;
  snapshot: AdmissionSnapshot;
};

export function snapshotSqliteDatabaseWriteScopes(
  current: Admission["writeScopes"],
  previous: WriteScopeBuckets = EMPTY_WRITE_SCOPE_BUCKETS,
  keys?: readonly string[],
): WriteScopeBuckets {
  let buckets = previous;
  const retention = scopeRetention.get(current);
  const visit = (value: ScopedWriteRevision | undefined, key: string) => {
    let hash = 0;
    for (let index = 0; index < key.length; index++) {
      hash = (hash * 31 + key.charCodeAt(index)) | 0;
    }
    const index = hash & (EMPTY_WRITE_SCOPE_BUCKETS.length - 1);
    const retired = !value || Atomics.load(value.state, 1) !== 0;
    if (retired) {
      if (current.delete(key) && retention) {
        retention.bytes -= writeScopeBytes(key);
      }
    }
    if (retired ? !previous[index]!.has(key) : previous[index]!.get(key) === value) {
      return;
    }
    if (buckets === previous) {
      buckets = previous.slice();
    }
    if (buckets[index] === previous[index]) {
      buckets[index] = new Map(previous[index]);
    }
    if (retired) {
      buckets[index]!.delete(key);
    } else {
      buckets[index]!.set(key, value!);
    }
  };
  if (keys) {
    for (const key of keys) {
      visit(current.get(key), key);
    }
  } else {
    current.forEach(visit);
  }
  for (const key of retention?.retired ?? []) {
    visit(current.get(key), key);
  }
  retention?.retired.clear();
  return buckets;
}

export type SqliteDatabaseAdmissionCursor = {
  revision: number;
  records: WeakMap<SharedArrayBuffer, PublishedAdmission>;
};

export function createSqliteDatabaseAdmissionCursor(): SqliteDatabaseAdmissionCursor {
  return { revision: -1, records: new WeakMap() };
}

export type SqliteDatabaseDescriptorCustody = Pick<
  Admission,
  "descriptor" | "descriptorCustody" | "facts"
> & {
  file: BigIntStats;
  location: string;
};
