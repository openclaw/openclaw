import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { setEnvironmentData, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SqliteCleanCloseSealRefusal } from "./sqlite-clean-close-seal.js";
import { changedAdmissionEntries } from "./sqlite-database-admission-delta.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  isSoleDatabaseFileDescriptor,
  readDatabaseIdentityBirthtime,
  normalizeDatabasePath,
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
const SQLITE_DATABASE_GENERATION_LENGTH = Object.keys(SqliteDatabaseGenerationSlot).length;

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
type AdmissionSnapshot = Omit<Admission, "writeScopes"> & { writeScopes: WriteScopeBuckets };
export type SqliteDatabaseAdmissions = AdmissionSnapshot[];
type AdmissionPublications = Map<Admission, string[] | undefined>;
export type SqliteDatabaseAdmissionKey<T> = {
  name: string;
  read(this: void, value: unknown): T | undefined;
  schemaDependent?: boolean;
  /** Physical validation and owner-published decisions survive ordinary native close. */
  lifetime?: "process";
  /** Physical cache facts can be recaptured locally; their transport never gates a live connection. */
  writer?: "host" | "connection";
};
export type SqliteDatabaseAdmissionExchange = (
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean,
) => SqliteDatabaseAdmissions;

/** Internal typed publications need no decoder; public/custom keys retain their read contract. */
export type SqliteDatabaseFactKey<T> = Omit<SqliteDatabaseAdmissionKey<T>, "read"> & {
  read?: SqliteDatabaseAdmissionKey<T>["read"];
};

export function readSqliteDatabaseAdmissions(value: unknown): SqliteDatabaseAdmissions | undefined {
  // SAFETY: These facts come only from this process's paired worker and bootstrap transports.
  return Array.isArray(value) ? (value as SqliteDatabaseAdmissions) : undefined;
}

export function isSqliteDatabaseAdmissionRetired(record: Pick<Admission, "generation">): boolean {
  return readSqliteDatabaseGeneration(record, "retired") !== 0;
}

export function isSqliteDatabaseAdmissionFactCurrent(
  record: Pick<Admission, "generation">,
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
type PublishedAdmission = {
  metadata: Omit<Admission, "writeScopes">;
  writeScopes: WriteScopeBuckets;
  snapshot: AdmissionSnapshot;
};

function snapshotWriteScopes(
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

function changedWriteScopes(
  current: WriteScopeBuckets,
  previous: WriteScopeBuckets,
): Admission["writeScopes"] {
  const changed = new Map<string, ScopedWriteRevision>();
  current.forEach((bucket, index) => {
    if (bucket !== previous[index]) {
      bucket.forEach((value, key) => {
        if (previous[index]!.get(key) !== value) {
          changed.set(key, value);
        }
      });
    }
  });
  return changed;
}

export type SqliteDatabaseAdmissionCursor = {
  revision: number;
  records: WeakMap<SharedArrayBuffer, PublishedAdmission>;
};

export function createSqliteDatabaseAdmissionCursor(): SqliteDatabaseAdmissionCursor {
  return { revision: -1, records: new WeakMap() };
}

export class SqliteDatabaseAdmissionRegistry {
  readonly records = new Map<string, Admission>();
  private exchangeCursor = createSqliteDatabaseAdmissionCursor();
  private readonly locations = new Map<string, string>();
  private readonly published = new Map<string, PublishedAdmission>();
  private readonly scopeSweeps = new WeakMap<Admission, number>();
  readonly descriptors = new Map<string, Pick<Admission, "descriptor" | "facts">>();
  private revision = 0;
  private retainProcessFacts = true;

  useConnectionScopedFacts(): void {
    this.retainProcessFacts = false;
  }

  changeReferences(record: Admission, change: 1 | -1): boolean {
    let references = record.references.get(threadId);
    if (!references) {
      references = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
      record.references.set(threadId, references);
    }
    const count = Atomics.add(new Int32Array(references), 0, change) + change;
    if (count !== (change === 1 ? 1 : 0)) {
      return false;
    }
    if (change === -1) {
      this.retireUnreferenced(record);
    }
    this.publish(record);
    return true;
  }

  private retireUnreferenced(record: Admission): void {
    if (
      threadId !== 0 ||
      isSqliteDatabaseAdmissionRetired(record) ||
      [...record.references.values()].some(
        (references) => Atomics.load(new Int32Array(references), 0) > 0,
      )
    ) {
      return;
    }
    for (const [name, fact] of record.facts) {
      if (
        !this.retainProcessFacts ||
        fact.lifetime !== "process" ||
        !isSqliteDatabaseAdmissionFactCurrent(record, fact)
      ) {
        record.facts.delete(name);
      }
    }
    const custody = this.descriptors.get(record.identity);
    if (custody) {
      custody.facts = record.facts;
    }
    // Row facts and receipts retire; shared-owner physical facts can stay with descriptor custody.
    Atomics.compareExchange(
      new Int32Array(record.generation),
      SqliteDatabaseGenerationSlot.retired,
      0,
      2,
    );
    record.writeScopes.clear();
  }

  releaseWorker(owner: number): void {
    const changedRecords: AdmissionPublications = new Map();
    for (const record of this.records.values()) {
      const references = owner > 0 ? record.references.get(owner) : undefined;
      if (!references) {
        continue;
      }
      // A terminated worker cannot run the transaction's diagnostic finally.
      Atomics.compareExchange(record.writerDiagnostic, 1, owner + 1, 0);
      // Zero permits a live worker to reopen; negative cells cannot be revived by old snapshots.
      Atomics.store(new Int32Array(references), 0, -1);
      this.retireUnreferenced(record);
      changedRecords.set(record, undefined);
    }
    if (changedRecords.size > 0) {
      this.publish(changedRecords);
    }
  }

  observeLocation(location: string, identity: string | undefined): void {
    const pathname = normalizeDatabasePath(path.resolve(location));
    if (identity === undefined) {
      this.locations.delete(pathname);
    } else {
      this.locations.set(pathname, identity);
    }
  }

  forLocation(location: string): Admission | undefined {
    return this.forPathname(normalizeDatabasePath(path.resolve(location)));
  }

  prepareLocation(location: string): () => Admission | undefined {
    const pathname = normalizeDatabasePath(path.resolve(location));
    return () => this.forPathname(pathname);
  }

  private forPathname(pathname: string): Admission | undefined {
    const identity = this.locations.get(pathname);
    const record = identity === undefined ? undefined : this.records.get(identity);
    return record && !isSqliteDatabaseAdmissionRetired(record) ? record : undefined;
  }

  hasSchemaAdmissionForIdentity(physicalIdentity: DatabaseFileIdentity): boolean {
    if (!physicalIdentity.key.startsWith("file:") || physicalIdentity.birthtime === undefined) {
      return false;
    }
    const key = `${physicalIdentity.key.slice("file:".length)}:${physicalIdentity.birthtime}`;
    return hasSqliteDatabaseSchemaAdmission(this.records.get(key));
  }

  forget(identity: string): void {
    this.records.delete(identity);
    this.published.delete(identity);
    for (const [location, observed] of this.locations) {
      if (observed === identity) {
        this.locations.delete(location);
      }
    }
  }

  retainDescriptor(location: string, descriptor: number, opened: BigIntStats): Admission {
    const retained = this.descriptors.get(readSqliteDatabaseAdmissionIdentity(opened));
    const record: Admission = {
      identity: readSqliteDatabaseAdmissionIdentity(opened),
      physicalIdentity: {
        key: `file:${opened.dev}:${opened.ino}`,
        birthtime: readDatabaseIdentityBirthtime(opened),
      },
      location,
      descriptor,
      descriptorOwner: 0,
      generationId: randomUUID(),
      generation: new SharedArrayBuffer(
        Int32Array.BYTES_PER_ELEMENT * SQLITE_DATABASE_GENERATION_LENGTH,
      ),
      writerDiagnostic: new Int32Array(new SharedArrayBuffer(125 * Int32Array.BYTES_PER_ELEMENT)),
      writeScopes: new Map(),
      writeScopeRevision: 0,
      references: new Map(),
      facts: new Map(
        [...(retained?.facts ?? [])]
          .filter(([, fact]) => Atomics.load(new Int32Array(fact.current), 0) === 1)
          .map(([name, fact]) => [name, { ...fact, revision: 0 }]),
      ),
    };
    this.records.set(record.identity, record);
    this.descriptors.set(record.identity, {
      descriptor,
      facts: new Map(),
    });
    this.observeLocation(location, record.identity);
    this.publish(record);
    return record;
  }

  /** Only the joined lifecycle owner may release a retained descriptor. */
  retireDescriptor(identity: string, options: { requireSoleDescriptor?: boolean }): boolean {
    const record = this.records.get(identity);
    const descriptor = this.descriptors.get(identity)?.descriptor ?? record?.descriptor;
    if (descriptor === undefined) {
      return false;
    }
    const file = fs.fstatSync(descriptor, { bigint: true });
    if (
      file.nlink > 1n ||
      (options.requireSoleDescriptor && !isSoleDatabaseFileDescriptor(descriptor, file))
    ) {
      return false;
    }
    if (record) {
      Atomics.store(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.retired, 1);
    }
    fs.closeSync(descriptor);
    this.descriptors.delete(identity);
    this.forget(identity);
    this.publish();
    return true;
  }

  publish(selected?: Admission | AdmissionPublications, scopeKeys?: readonly string[]): void {
    const isBatch = selected instanceof Map;
    if (selected && !isBatch && this.records.get(selected.identity) !== selected) {
      return;
    }
    // Another isolate can retire shared custody. Reclaim it at publication, not on every request.
    for (const current of this.records.values()) {
      if (isSqliteDatabaseAdmissionRetired(current)) {
        if (readSqliteDatabaseGeneration(current, "retired") === 1) {
          this.descriptors.delete(current.identity);
        }
        this.forget(current.identity);
        continue;
      }
      if (selected && selected !== current && !(isBatch && selected.has(current))) {
        continue;
      }
      let changed = selected === current || isBatch;
      for (const [owner, references] of current.references) {
        if (Atomics.load(new Int32Array(references), 0) < 0) {
          current.references.delete(owner);
          changed = true;
        }
      }
      const previous = this.published.get(current.identity);
      const scopeRevision = readSqliteDatabaseGeneration(current, "writeScopeRevision");
      const keys = previous && selected ? (isBatch ? selected.get(current) : scopeKeys) : undefined;
      const sweep = keys === undefined && this.scopeSweeps.get(current) !== scopeRevision;
      const writeScopes = snapshotWriteScopes(
        current.writeScopes,
        previous?.writeScopes,
        keys ?? (sweep ? undefined : []),
      );
      // Keyed publications can acknowledge a revision without sweeping remote retirements.
      if (sweep) {
        this.scopeSweeps.set(current, scopeRevision);
      }
      changed ||= writeScopes !== previous?.writeScopes;
      if (!changed) {
        continue;
      }
      if (threadId === 0) {
        current.writeScopeRevision = readSqliteDatabaseGeneration(current, "writeScopeRevision");
      }
      const { writeScopes: _ownedScopes, ...fields } = current;
      const metadata = {
        ...fields,
        facts: new Map(current.facts),
        references: new Map(current.references),
        hostRevision:
          threadId === 0
            ? readSqliteDatabaseGeneration(current, "hostRevision")
            : current.hostRevision,
      };
      // Clone the immutable buckets directly; receivers install cells into their owned Map.
      const snapshot: AdmissionSnapshot = {
        ...metadata,
        writeScopes: writeScopes.filter((bucket) => bucket.size > 0),
      };
      this.published.set(current.identity, { metadata, writeScopes, snapshot });
    }
    this.revision++;
    setEnvironmentData(
      SQLITE_DATABASE_ADMISSIONS_KEY,
      [...this.published.values()].map((record) => record.snapshot),
    );
  }

  capture(
    cursor?: SqliteDatabaseAdmissionCursor,
    scope?: { location?: string; admissions?: readonly Pick<Admission, "identity">[] },
  ): SqliteDatabaseAdmissions {
    const identities = scope
      ? new Set([
          ...(scope.admissions?.map((record) => record.identity) ?? []),
          ...(scope.location === undefined
            ? []
            : [this.forLocation(scope.location)?.identity].filter((value) => value !== undefined)),
        ])
      : undefined;
    if (!identities && !cursor) {
      this.publish();
    }
    if (!identities && cursor?.revision === this.revision) {
      return [];
    }
    const records = identities
      ? [...identities].flatMap((identity) => {
          const record = this.published.get(identity);
          return record && !isSqliteDatabaseAdmissionRetired(record.snapshot) ? [record] : [];
        })
      : [...this.published.values()];
    if (!cursor) {
      return records.map((record) => record.snapshot);
    }
    // A scoped reply cannot acknowledge snapshots belonging to other databases.
    if (!identities) {
      cursor.revision = this.revision;
    }
    return records.flatMap((record) => {
      const previous = cursor.records.get(record.metadata.generation);
      if (previous === record) {
        return [];
      }
      cursor.records.set(record.metadata.generation, record);
      // One cursor follows one ordered receiver. Shared cells already carry revocation;
      // resend only replaced entries, not every session's buffer after each publication.
      return [
        previous
          ? {
              ...record.metadata,
              facts: changedAdmissionEntries(record.metadata.facts, previous.metadata.facts),
              writeScopes: [changedWriteScopes(record.writeScopes, previous.writeScopes)],
              references: changedAdmissionEntries(
                record.metadata.references,
                previous.metadata.references,
              ),
            }
          : record.snapshot,
      ];
    });
  }

  captureExchange(
    scope?: { location?: string; admissions?: readonly Pick<Admission, "identity">[] },
    target?: string | Admission,
  ) {
    return target && typeof target !== "string" && isSqliteDatabaseAdmissionRetired(target)
      ? [{ ...target, facts: new Map(), writeScopes: [], references: new Map() }]
      : this.capture(this.exchangeCursor, scope);
  }

  resetExchangeCursor(): void {
    this.exchangeCursor = createSqliteDatabaseAdmissionCursor();
  }

  install(admissions: SqliteDatabaseAdmissions): boolean {
    const changedRecords: AdmissionPublications = new Map();
    for (const incoming of admissions) {
      let record = this.records.get(incoming.identity);
      if (incoming.descriptorOwner !== 0 || isSqliteDatabaseAdmissionRetired(incoming)) {
        if (record && isSqliteDatabaseAdmissionRetired(record)) {
          changedRecords.set(record, undefined);
        }
        continue;
      }
      let changed = false;
      if (record && isSqliteDatabaseAdmissionRetired(record)) {
        record = undefined;
      }
      if (!record) {
        record = {
          ...incoming,
          facts: new Map(incoming.facts),
          writeScopes: new Map(),
          references: new Map(incoming.references),
          hostRevision: undefined,
        };
        this.records.set(incoming.identity, record);
        this.observeLocation(incoming.location, incoming.identity);
        changed = true;
      } else if (record.generationId !== incoming.generationId) {
        // Only the host creates a generation; unrelated revocation cells cannot certify its facts.
        continue;
      }
      if (!record.cleanCloseRefusal && incoming.cleanCloseRefusal) {
        record.cleanCloseRefusal = incoming.cleanCloseRefusal;
        changed = true;
      }
      for (const [key, fact] of incoming.facts) {
        if (
          isSqliteDatabaseAdmissionFactCurrent(incoming, fact) &&
          record.facts.get(key)?.publication !== fact.publication
        ) {
          record.facts.set(key, fact);
          changed = true;
        }
      }
      const scopeKeys = changedRecords.get(record) ?? [];
      for (const bucket of incoming.writeScopes) {
        for (const [key, revision] of bucket) {
          if (Atomics.load(revision.state, 1) !== 0) {
            continue;
          }
          // The host selects one shared incarnation for concurrent discoveries of the same key.
          const previous = record.writeScopes.get(key);
          if (
            previous?.identity === revision.identity ||
            (threadId === 0 && previous && Atomics.load(previous.state, 1) === 0)
          ) {
            continue;
          }
          if (threadId === 0) {
            const previousRevision = advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
            // The keyed publication covers this addition, never an unseen peer's retirement.
            if (this.scopeSweeps.get(record) === previousRevision) {
              this.scopeSweeps.set(record, (previousRevision + 1) | 0);
            }
          }
          retainSqliteDatabaseWriteScope(record, key, revision);
          scopeKeys.push(key);
          changed = true;
        }
      }
      const writeScopeRevision = readSqliteDatabaseGeneration(record, "writeScopeRevision");
      if (threadId === 0 || incoming.writeScopeRevision === writeScopeRevision) {
        changed ||= record.writeScopeRevision !== writeScopeRevision;
        record.writeScopeRevision = writeScopeRevision;
      }
      for (const [owner, references] of incoming.references) {
        if (!record.references.has(owner) && Atomics.load(new Int32Array(references), 0) >= 0) {
          record.references.set(owner, references);
          changed = true;
        }
      }
      if (
        threadId !== 0 &&
        incoming.hostRevision !== undefined &&
        incoming.hostRevision !== record.hostRevision &&
        incoming.hostRevision === readSqliteDatabaseGeneration(record, "hostRevision")
      ) {
        record.hostRevision = incoming.hostRevision;
        changed = true;
      }
      // Only the host has every borrower's reference cell; worker snapshots can omit later peers.
      this.retireUnreferenced(record);
      if (changed || isSqliteDatabaseAdmissionRetired(record)) {
        // Reuse the admitted snapshot; only imported cells need keyed publication.
        changedRecords.set(record, scopeKeys.length > 0 ? scopeKeys : undefined);
      }
    }
    if (changedRecords.size > 0) {
      this.publish(changedRecords);
    }
    return changedRecords.size > 0;
  }
}
