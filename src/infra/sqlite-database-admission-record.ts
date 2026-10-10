import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readWorkerAncestors, workerAncestors } from "./worker-ancestry.js";

export const SqliteDatabaseGenerationSlot = {
  schemaRevision: 0,
  factRevision: 1,
  publicationRevision: 2,
  retired: 3,
  writerCount: 4,
  writeRevision: 5,
  hostRevision: 6,
} as const;
export const SQLITE_DATABASE_GENERATION_LENGTH = Object.keys(SqliteDatabaseGenerationSlot).length;

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
type Writer = { cell: SharedArrayBuffer; ancestors: readonly number[] };
export type Admission = {
  identity: string;
  location: string;
  descriptor: number;
  descriptorOwner: number;
  generationId: string;
  generation: SharedArrayBuffer;
  /** Last complete host snapshot; relays preserve this value without advancing it. */
  hostRevision?: number;
  writers: Map<number, Writer>;
  facts: Map<string, AdmissionFact>;
};
export type SqliteDatabaseAdmissions = Admission[];
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
  if (!(value.writers instanceof Map)) {
    return undefined;
  }
  const writers = new Map<number, Writer>();
  for (const [writer, custody] of value.writers) {
    if (
      typeof writer !== "number" ||
      !Number.isInteger(writer) ||
      writer < 0 ||
      !isRecord(custody) ||
      !(custody.cell instanceof SharedArrayBuffer) ||
      custody.cell.byteLength !== 3 * Int32Array.BYTES_PER_ELEMENT
    ) {
      return undefined;
    }
    const ancestors = readWorkerAncestors(custody.ancestors);
    if (!ancestors || ancestors.includes(writer)) {
      return undefined;
    }
    writers.set(writer, { cell: custody.cell, ancestors });
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
    location: value.location,
    descriptor: value.descriptor,
    descriptorOwner: value.descriptorOwner,
    generationId: value.generationId,
    generation: value.generation,
    ...(value.hostRevision !== undefined ? { hostRevision: value.hostRevision } : {}),
    writers,
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

export function registerWriterCustody(record: Admission): void {
  if (threadId !== 0) {
    return;
  }
  for (const { cell } of record.writers.values()) {
    const writer = new Int32Array(cell);
    if (Atomics.load(writer, 1) === 0) {
      // Only thread 0 allocates registrations, after installing their metadata.
      Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.writerCount, 1);
      Atomics.store(writer, 1, 1);
    }
  }
}

export function isSqliteDatabaseAdmissionFactCurrent(
  record: Admission,
  fact: AdmissionFact,
): boolean {
  const cell = new Int32Array(record.generation);
  return (
    !isSqliteDatabaseAdmissionRetired(record) &&
    Atomics.load(new Int32Array(fact.current), 0) === 1 &&
    fact.revision ===
      Atomics.load(
        cell,
        fact.schemaDependent
          ? SqliteDatabaseGenerationSlot.schemaRevision
          : SqliteDatabaseGenerationSlot.factRevision,
      )
  );
}

export function captureSqliteDatabaseAdmissionRecords(
  records: Map<string, Admission>,
  cursor?: Map<string, string>,
): SqliteDatabaseAdmissions {
  const result: SqliteDatabaseAdmissions = [];
  for (const record of records.values()) {
    if (isSqliteDatabaseAdmissionRetired(record)) {
      records.delete(record.identity);
      continue;
    }
    const cell = new Int32Array(record.generation);
    // Only the host can certify new completeness. Worker relays retain the exact
    // host snapshot they received, including when the shared epoch has advanced.
    const hostRevision =
      threadId === 0
        ? Atomics.load(cell, SqliteDatabaseGenerationSlot.hostRevision)
        : record.hostRevision;
    const facts = new Map(
      [...record.facts].filter(([, fact]) => isSqliteDatabaseAdmissionFactCurrent(record, fact)),
    );
    if (cursor) {
      // A reused inode starts a new custody generation even when its counters match.
      const revision = `${record.generationId}:${Atomics.load(cell, SqliteDatabaseGenerationSlot.schemaRevision)}:${Atomics.load(cell, SqliteDatabaseGenerationSlot.factRevision)}:${Atomics.load(cell, SqliteDatabaseGenerationSlot.writerCount)}:${hostRevision ?? ""}:${[...record.writers.keys()].join(",")}:${[...facts.values()].map((fact) => fact.publication).join(",")}`;
      if (cursor.get(record.identity) === revision) {
        continue;
      }
      cursor.set(record.identity, revision);
    }
    result.push({ ...record, facts, hostRevision });
  }
  return result;
}

export function activeSqliteDatabaseWriters(
  record: Admission,
  index: 0 | 2,
  refresh: (location: string) => void,
): number | undefined {
  const generation = new Int32Array(record.generation);
  let registrations = Atomics.load(generation, SqliteDatabaseGenerationSlot.writerCount);
  const known = () =>
    [...record.writers.values()].filter(({ cell }) => Atomics.load(new Int32Array(cell), 1) === 1)
      .length;
  if (known() < registrations) {
    refresh(record.location);
    registrations = Atomics.load(generation, SqliteDatabaseGenerationSlot.writerCount);
    if (known() < registrations) {
      return undefined;
    }
  }
  let active = 0;
  for (const { cell } of record.writers.values()) {
    active += Atomics.load(new Int32Array(cell), index);
  }
  return registrations === Atomics.load(generation, SqliteDatabaseGenerationSlot.writerCount)
    ? active
    : undefined;
}

export function readSqliteDatabaseRecordWriteRevision(
  record: Admission,
  ownWriters: number,
  refresh: (location: string) => void,
): number | undefined {
  const cell = new Int32Array(record.generation);
  const revision = Atomics.load(cell, SqliteDatabaseGenerationSlot.writeRevision);
  const active = activeSqliteDatabaseWriters(record, 2, refresh);
  if (
    active === undefined ||
    active > ownWriters ||
    revision !== Atomics.load(cell, SqliteDatabaseGenerationSlot.writeRevision)
  ) {
    return undefined;
  }
  return revision;
}

export function retireSqliteDatabaseWriter(record: Admission, id: number): void {
  const joined: Int32Array[] = [];
  for (const [writer, { cell, ancestors }] of record.writers) {
    if (writer === id || ancestors.includes(id)) {
      joined.push(new Int32Array(cell));
    }
  }
  if (joined.some((cell) => Atomics.load(cell, 0) > 0)) {
    // Native parent exit also joins descendants whose JS exit listeners cannot run.
    // Revoke possibly unpublished commits before releasing their shared writer fence.
    Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.schemaRevision, 1);
    for (const cell of joined) {
      Atomics.store(cell, 0, 0);
    }
  }
  if (joined.some((cell) => Atomics.load(cell, 2) > 0)) {
    // The joined native connection may have committed before its JS receipt ran.
    Atomics.add(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.writeRevision, 1);
    for (const cell of joined) {
      Atomics.store(cell, 2, 0);
    }
  }
}

export function ensureSqliteDatabaseWriter(record: Admission, publish: () => void): void {
  let custody = record.writers.get(threadId);
  if (!custody) {
    custody = {
      cell: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3),
      ancestors: workerAncestors,
    };
    record.writers.set(threadId, custody);
  }
  const { cell } = custody;
  if (Atomics.load(new Int32Array(cell), 1) === 0) {
    registerWriterCustody(record);
    // Publish custody before native work starts, so an exit can retire this cell.
    publish();
    if (Atomics.load(new Int32Array(cell), 1) === 0) {
      throw new Error("SQLite mutation requires host custody");
    }
  }
}

export function publishSqliteDatabaseFact(
  record: Admission,
  key: { name: string; schemaDependent?: boolean; writer?: "host" },
  value: unknown,
  revision: number,
  publication: string,
): boolean {
  if (
    revision !==
    Atomics.load(
      new Int32Array(record.generation),
      key.schemaDependent
        ? SqliteDatabaseGenerationSlot.schemaRevision
        : SqliteDatabaseGenerationSlot.factRevision,
    )
  ) {
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
