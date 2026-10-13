import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { setEnvironmentData, threadId } from "node:worker_threads";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
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
  writeScopeCount: 7,
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
  writeScopes: Map<string, SharedArrayBuffer>;
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

export type SqliteDatabaseAdmissionCursor = { revision: number; records: WeakSet<Admission> };

export function createSqliteDatabaseAdmissionCursor(): SqliteDatabaseAdmissionCursor {
  return { revision: -1, records: new WeakSet() };
}

export class SqliteDatabaseAdmissionRegistry {
  readonly records = new Map<string, Admission>();
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
    if (change === -1) {
      this.retireUnreferenced(record);
    }
    this.publish(record);
    return true;
  }

  private retireUnreferenced(record: Admission): void {
    if (
      threadId !== 0 ||
      [...record.references.values()].some((references) =>
        Atomics.load(new Int32Array(references), 0),
      )
    ) {
      return;
    }
    // Closed metadata releases its payloads; only explicit retirement closes descriptor custody.
    Atomics.compareExchange(
      new Int32Array(record.generation),
      SqliteDatabaseGenerationSlot.retired,
      0,
      2,
    );
    record.facts.clear();
    record.writeScopes.clear();
  }

  releaseWorker(owner: number): void {
    for (const record of this.records.values()) {
      const references = owner > 0 ? record.references.get(owner) : undefined;
      if (references) {
        Atomics.store(new Int32Array(references), 0, 0);
        record.references.delete(owner);
        this.retireUnreferenced(record);
      }
      advanceSqliteDatabaseGeneration(record, "writeRevision");
      advanceSqliteDatabaseGeneration(record, "unscopedWriteRevision");
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
      references: new Map(),
      facts: new Map(),
    };
    this.records.set(record.identity, record);
    this.descriptors.set(record.identity, descriptor);
    this.observeLocation(location, record.identity);
    this.publish(record);
    return record;
  }

  publish(record?: Admission): void {
    // Another isolate can retire shared custody. Reclaim it at publication, not on every request.
    for (const [identity, current] of this.records) {
      if (isSqliteDatabaseAdmissionRetired(current)) {
        if (readSqliteDatabaseGeneration(current, "retired") === 1) {
          this.descriptors.delete(identity);
        }
        this.forget(identity);
      }
    }
    if (record && !isSqliteDatabaseAdmissionRetired(record)) {
      // Snapshots change only at publication. Shared cells still revoke transferred facts immediately.
      this.published.set(record.identity, {
        ...record,
        facts: new Map(record.facts),
        writeScopes: new Map(record.writeScopes),
        references: new Map(record.references),
        hostRevision:
          threadId === 0
            ? readSqliteDatabaseGeneration(record, "hostRevision")
            : record.hostRevision,
      });
    }
    this.revision++;
    setEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY, [...this.published.values()]);
  }

  capture(
    cursor?: SqliteDatabaseAdmissionCursor,
    identities?: ReadonlySet<string>,
  ): SqliteDatabaseAdmissions {
    if (!identities && !cursor) {
      this.publish();
      return [...this.published.values()];
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
    return records.filter((record) => {
      if (cursor.records.has(record)) {
        return false;
      }
      cursor.records.add(record);
      return true;
    });
  }

  install(admissions: SqliteDatabaseAdmissions): void {
    if (admissions.length === 0) {
      return;
    }
    this.publish();
    for (const incoming of admissions) {
      if (incoming.descriptorOwner !== 0 || isSqliteDatabaseAdmissionRetired(incoming)) {
        continue;
      }
      let changed = false;
      let record = this.records.get(incoming.identity);
      if (record && isSqliteDatabaseAdmissionRetired(record)) {
        this.records.delete(record.identity);
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
        // The host selects one shared cell when concurrent isolates discover a key.
        if (
          record.writeScopes.get(key) === revision ||
          (threadId === 0 && record.writeScopes.has(key))
        ) {
          continue;
        }
        if (threadId === 0) {
          advanceSqliteDatabaseGeneration(record, "writeScopeCount");
        }
        record.writeScopes.set(key, revision);
        changed = true;
      }
      for (const [owner, references] of incoming.references) {
        if (!record.references.has(owner)) {
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
        this.publish(record);
      }
    }
  }
}
