import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { setEnvironmentData, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  readDatabaseIdentityBirthtime,
  normalizeDatabasePath,
  readDatabaseFileIdentity,
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

function readAdmissionFact(value: unknown): AdmissionFact | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== "number" ||
    typeof value.schemaDependent !== "boolean" ||
    typeof value.publication !== "string" ||
    !(value.current instanceof SharedArrayBuffer) ||
    value.current.byteLength !== Int32Array.BYTES_PER_ELEMENT
  ) {
    return undefined;
  }
  return {
    value: value.value,
    revision: value.revision,
    schemaDependent: value.schemaDependent,
    publication: value.publication,
    current: value.current,
  };
}

function readInheritedAdmission(value: unknown): Admission | undefined {
  if (
    !isRecord(value) ||
    typeof value.identity !== "string" ||
    typeof value.location !== "string" ||
    typeof value.descriptor !== "number" ||
    typeof value.descriptorOwner !== "number" ||
    typeof value.generationId !== "string" ||
    !(value.generation instanceof SharedArrayBuffer) ||
    value.generation.byteLength !==
      SQLITE_DATABASE_GENERATION_LENGTH * Int32Array.BYTES_PER_ELEMENT ||
    (value.hostRevision !== undefined &&
      (typeof value.hostRevision !== "number" || !Number.isInteger(value.hostRevision))) ||
    !(value.facts instanceof Map)
  ) {
    return undefined;
  }
  if (!(value.writeScopes instanceof Map)) {
    return undefined;
  }
  let physicalIdentity: DatabaseFileIdentity;
  try {
    physicalIdentity = readDatabaseFileIdentity(value.physicalIdentity);
  } catch {
    return undefined;
  }
  const writeScopes = new Map<string, SharedArrayBuffer>();
  for (const [key, revision] of value.writeScopes) {
    if (
      typeof key !== "string" ||
      !(revision instanceof SharedArrayBuffer) ||
      revision.byteLength !== Int32Array.BYTES_PER_ELEMENT
    ) {
      return undefined;
    }
    writeScopes.set(key, revision);
  }
  const facts = new Map<string, AdmissionFact>();
  for (const [key, entry] of value.facts) {
    const fact = readAdmissionFact(entry);
    if (typeof key !== "string" || !fact) {
      return undefined;
    }
    facts.set(key, fact);
  }
  return {
    identity: value.identity,
    physicalIdentity,
    location: value.location,
    descriptor: value.descriptor,
    descriptorOwner: value.descriptorOwner,
    generationId: value.generationId,
    generation: value.generation,
    ...(value.hostRevision !== undefined ? { hostRevision: value.hostRevision } : {}),
    writeScopes,
    facts,
  };
}

export function readSqliteDatabaseAdmissions(value: unknown): SqliteDatabaseAdmissions | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const admissions: SqliteDatabaseAdmissions = [];
  for (const entry of value) {
    const record = readInheritedAdmission(entry);
    if (!record) {
      return undefined;
    }
    admissions.push(record);
  }
  return admissions;
}

export function isSqliteDatabaseAdmissionRetired(record: Admission): boolean {
  return (
    Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.retired) !== 0
  );
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
  return Atomics.load(
    new Int32Array(record.generation),
    schemaDependent
      ? SqliteDatabaseGenerationSlot.schemaRevision
      : SqliteDatabaseGenerationSlot.factRevision,
  );
}

export function readSqliteDatabaseRecordWriteRevision(record: Admission): number {
  return Atomics.load(
    new Int32Array(record.generation),
    SqliteDatabaseGenerationSlot.writeRevision,
  );
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
    Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.hostRevision, 1);
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
  Atomics.add(
    new Int32Array(record.generation),
    SqliteDatabaseGenerationSlot.publicationRevision,
    1,
  );
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
  private revision = 0;

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
      facts: new Map(),
    };
    this.records.set(record.identity, record);
    this.observeLocation(location, record.identity);
    this.publish(record);
    return record;
  }

  publish(record?: Admission): void {
    // Another isolate can retire shared custody. Reclaim it at publication, not on every request.
    for (const [identity, snapshot] of this.published) {
      if (isSqliteDatabaseAdmissionRetired(snapshot)) {
        if (this.records.get(identity)?.generationId === snapshot.generationId) {
          this.records.delete(identity);
        }
        this.published.delete(identity);
      }
    }
    if (record && !isSqliteDatabaseAdmissionRetired(record)) {
      // Snapshots change only at publication. Shared cells still revoke transferred facts immediately.
      this.published.set(record.identity, {
        ...record,
        facts: new Map(record.facts),
        writeScopes: new Map(record.writeScopes),
        hostRevision:
          threadId === 0
            ? Atomics.load(
                new Int32Array(record.generation),
                SqliteDatabaseGenerationSlot.hostRevision,
              )
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
          Atomics.add(
            new Int32Array(record.generation),
            SqliteDatabaseGenerationSlot.writeScopeCount,
            1,
          );
        }
        record.writeScopes.set(key, revision);
        changed = true;
      }
      if (
        threadId !== 0 &&
        incoming.hostRevision !== undefined &&
        incoming.hostRevision !== record.hostRevision &&
        incoming.hostRevision ===
          Atomics.load(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.hostRevision)
      ) {
        record.hostRevision = incoming.hostRevision;
        changed = true;
      }
      if (changed) {
        this.publish(record);
      }
    }
  }
}
