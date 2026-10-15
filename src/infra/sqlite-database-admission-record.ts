import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { setEnvironmentData, threadId } from "node:worker_threads";
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

export type AdmissionFact = {
  value: unknown;
  revision: number;
  schemaDependent: boolean;
  publication: string;
  current: SharedArrayBuffer;
};
export type StagedAdmissionFact = Pick<AdmissionFact, "value" | "revision" | "schemaDependent"> & {
  ddlRevision: number;
};
export type ScopedWriteRevision = {
  identity: string;
  // The revision and retirement flag share custody across all admission snapshots.
  state: Int32Array<SharedArrayBuffer>;
};

export type Admission = {
  identity: string;
  physicalIdentity: DatabaseFileIdentity;
  location: string;
  descriptor: number;
  descriptorOwner: number;
  generationId: string;
  generation: SharedArrayBuffer;
  /** Last complete host snapshot; relays preserve this value without advancing it. */
  hostRevision?: number;
  writeScopes: Map<string, ScopedWriteRevision>;
  writeScopeRevision: number;
  references: Map<number, SharedArrayBuffer>;
  facts: Map<string, AdmissionFact>;
};
export type SqliteDatabaseAdmissions = Admission[];
export type SqliteDatabaseAdmissionKey<T> = {
  name: string;
  read(this: void, value: unknown): T | undefined;
  schemaDependent?: boolean;
  writer?: "host";
};
export type SqliteDatabaseAdmissionExchange = (
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean,
) => SqliteDatabaseAdmissions;

export function readSqliteDatabaseAdmissions(value: unknown): SqliteDatabaseAdmissions | undefined {
  // SAFETY: These facts come only from this process's paired worker and bootstrap transports.
  return Array.isArray(value) ? (value as SqliteDatabaseAdmissions) : undefined;
}

export function isSqliteDatabaseAdmissionRetired(record: Admission): boolean {
  return readSqliteDatabaseGeneration(record, "retired") !== 0;
}

export function isSqliteDatabaseAdmissionFactCurrent(
  record: Admission,
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
  record: Admission,
  schemaDependent: boolean | undefined,
): number {
  return readSqliteDatabaseGeneration(record, schemaDependent ? "schemaRevision" : "factRevision");
}

export function readSqliteDatabaseGeneration(
  record: Admission,
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
  key: { name: string; schemaDependent?: boolean; writer?: "host" },
  value: unknown,
  revision: number,
  publication: string,
): boolean {
  if (revision !== readSqliteDatabaseFactRevision(record, key.schemaDependent)) {
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
    value,
    revision,
    schemaDependent: key.schemaDependent === true,
    publication,
    current,
  });
  advanceSqliteDatabaseGeneration(record, "publicationRevision");
  return true;
}

export type SqliteDatabaseAdmissionCursor = {
  revision: number;
  records: WeakMap<SharedArrayBuffer, Admission>;
};

export function createSqliteDatabaseAdmissionCursor(): SqliteDatabaseAdmissionCursor {
  return { revision: -1, records: new WeakMap() };
}

function changedAdmissionEntries<Key, Value>(
  current: Map<Key, Value>,
  previous: Map<Key, Value>,
): Map<Key, Value> {
  const changed = new Map<Key, Value>();
  for (const [key, value] of current) {
    if (previous.get(key) !== value) {
      changed.set(key, value);
    }
  }
  return changed;
}

export class SqliteDatabaseAdmissionRegistry {
  readonly records = new Map<string, Admission>();
  private exchangeCursor = createSqliteDatabaseAdmissionCursor();
  private readonly locations = new Map<string, string>();
  private readonly published = new Map<string, Admission>();
  readonly descriptors = new Map<string, number>();
  private revision = 0;

  changeReferences(record: Admission, change: 1 | -1): boolean {
    let references = record.references.get(threadId);
    if (!references) {
      references = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      record.references.set(threadId, references);
    }
    const count = Atomics.add(new Int32Array(references), 0, change) + change;
    if (count !== (change === 1 ? 1 : 0)) {
      return false;
    }
    this.publish(record);
    return true;
  }

  releaseWorker(owner: number): void {
    for (const record of this.records.values()) {
      const references = owner > 0 ? record.references.get(owner) : undefined;
      // A worker cannot leave an unpublished write in a database it never borrowed.
      if (!references) {
        continue;
      }
      // Zero permits a live worker to reopen; negative cells cannot be revived by old snapshots.
      const priorReferences = Atomics.exchange(new Int32Array(references), 0, -1);
      // Native close settles receipts before releasing the worker's final reference.
      if (priorReferences <= 0) {
        continue;
      }
      advanceSqliteDatabaseGeneration(record, "writeRevision");
      advanceSqliteDatabaseGeneration(record, "unscopedWriteRevision");
      // A worker can commit DDL before its outer native call publishes admission receipts.
      advanceSqliteDatabaseGeneration(record, "schemaRevision");
      advanceSqliteDatabaseGeneration(record, "factRevision");
    }
    this.publish();
  }

  observeLocation(location: string, identity: string): void {
    this.locations.set(normalizeDatabasePath(path.resolve(location)), identity);
  }

  forLocation(location: string): Admission | undefined {
    const identity = this.locations.get(normalizeDatabasePath(path.resolve(location)));
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
      writeScopes: new Map(),
      writeScopeRevision: 0,
      references: new Map(),
      facts: new Map(),
    };
    this.records.set(record.identity, record);
    this.descriptors.set(record.identity, descriptor);
    this.observeLocation(location, record.identity);
    this.publish(record);
    return record;
  }

  /** Only the joined lifecycle owner may release a retained descriptor. */
  retireDescriptor(identity: string, options: { requireSoleDescriptor?: boolean }): boolean {
    const record = this.records.get(identity);
    const descriptor = this.descriptors.get(identity) ?? record?.descriptor;
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

  publish(selected?: Admission | Set<Admission>): void {
    if (
      selected &&
      !(selected instanceof Set) &&
      this.records.get(selected.identity) !== selected
    ) {
      return;
    }
    // Another isolate can retire shared custody. Reclaim it at publication, not on every request.
    for (const current of this.records.values()) {
      if (isSqliteDatabaseAdmissionRetired(current)) {
        this.descriptors.delete(current.identity);
        this.forget(current.identity);
        continue;
      }
      if (selected && selected !== current && !(selected instanceof Set && selected.has(current))) {
        continue;
      }
      let changed = selected === current || selected instanceof Set;
      for (const [owner, references] of current.references) {
        if (Atomics.load(new Int32Array(references), 0) < 0) {
          current.references.delete(owner);
          changed = true;
        }
      }
      for (const [key, revision] of current.writeScopes) {
        if (Atomics.load(revision.state, 1) !== 0) {
          current.writeScopes.delete(key);
          changed = true;
        }
      }
      if (!changed) {
        continue;
      }
      if (threadId === 0) {
        current.writeScopeRevision = readSqliteDatabaseGeneration(current, "writeScopeRevision");
      }
      // Snapshots change only at publication. Shared cells still revoke transferred facts immediately.
      this.published.set(current.identity, {
        ...current,
        facts: new Map(current.facts),
        writeScopes: new Map(current.writeScopes),
        references: new Map(current.references),
        hostRevision:
          threadId === 0
            ? readSqliteDatabaseGeneration(current, "hostRevision")
            : current.hostRevision,
      });
    }
    this.revision++;
    setEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY, [...this.published.values()]);
  }

  capture(
    cursor?: SqliteDatabaseAdmissionCursor,
    scope?: { location?: string; admissions?: SqliteDatabaseAdmissions },
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
          return record && !isSqliteDatabaseAdmissionRetired(record) ? [record] : [];
        })
      : [...this.published.values()];
    if (!cursor) {
      return records;
    }
    // A scoped reply cannot acknowledge snapshots belonging to other databases.
    if (!identities) {
      cursor.revision = this.revision;
    }
    return records.flatMap((record) => {
      const previous = cursor.records.get(record.generation);
      if (previous === record) {
        return [];
      }
      cursor.records.set(record.generation, record);
      // One cursor follows one ordered receiver. Shared cells already carry revocation;
      // resend only replaced entries, not every session's buffer after each publication.
      return [
        previous
          ? {
              ...record,
              facts: changedAdmissionEntries(record.facts, previous.facts),
              writeScopes: changedAdmissionEntries(record.writeScopes, previous.writeScopes),
              references: changedAdmissionEntries(record.references, previous.references),
            }
          : record,
      ];
    });
  }

  captureExchange(
    scope?: { location?: string; admissions?: SqliteDatabaseAdmissions },
    target?: string | Admission,
  ) {
    return target && typeof target !== "string" && isSqliteDatabaseAdmissionRetired(target)
      ? [{ ...target, facts: new Map(), writeScopes: new Map(), references: new Map() }]
      : this.capture(this.exchangeCursor, scope);
  }

  resetExchangeCursor(): void {
    this.exchangeCursor = createSqliteDatabaseAdmissionCursor();
  }

  install(admissions: SqliteDatabaseAdmissions): boolean {
    const changedRecords = new Set<Admission>();
    for (const incoming of admissions) {
      let record = this.records.get(incoming.identity);
      if (incoming.descriptorOwner !== 0 || isSqliteDatabaseAdmissionRetired(incoming)) {
        if (record && isSqliteDatabaseAdmissionRetired(record)) {
          changedRecords.add(record);
        }
        continue;
      }
      let changed = false;
      if (record && isSqliteDatabaseAdmissionRetired(record)) {
        record = undefined;
      }
      if (!record) {
        record = { ...incoming, hostRevision: undefined };
        this.records.set(incoming.identity, record);
        this.observeLocation(incoming.location, incoming.identity);
        changed = true;
      } else if (record.generationId !== incoming.generationId) {
        // Only the host creates a generation; unrelated revocation cells cannot certify its facts.
        continue;
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
      for (const [key, revision] of incoming.writeScopes) {
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
          advanceSqliteDatabaseGeneration(record, "writeScopeRevision");
        }
        record.writeScopes.set(key, revision);
        changed = true;
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
      if (changed) {
        changedRecords.add(record);
      }
    }
    if (changedRecords.size > 0) {
      this.publish(changedRecords);
      return true;
    }
    return false;
  }
}
