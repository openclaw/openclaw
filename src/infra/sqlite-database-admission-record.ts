import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readWorkerAncestors } from "./worker-ancestry.js";

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
  writers: Map<number, Writer>;
  facts: Map<string, AdmissionFact>;
};
export type SqliteDatabaseAdmissions = Admission[];

export function captureSqliteDatabaseAdmissionRecords(
  records: Iterable<Admission>,
  cursor: Map<string, string> | undefined,
  forgetRetired: (record: Admission) => void,
): SqliteDatabaseAdmissions {
  const result: SqliteDatabaseAdmissions = [];
  for (const record of records) {
    if (isSqliteDatabaseAdmissionRetired(record)) {
      forgetRetired(record);
      continue;
    }
    const facts = new Map(
      [...record.facts].filter(([, fact]) => isSqliteDatabaseAdmissionFactCurrent(record, fact)),
    );
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
    value.generation.byteLength !== 5 * Int32Array.BYTES_PER_ELEMENT ||
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
      custody.cell.byteLength !== 2 * Int32Array.BYTES_PER_ELEMENT
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
  return Atomics.load(new Int32Array(record.generation), 3) !== 0;
}

export function registerWriterCustody(record: Admission): void {
  if (threadId !== 0) {
    return;
  }
  for (const { cell } of record.writers.values()) {
    const writer = new Int32Array(cell);
    if (Atomics.load(writer, 1) === 0) {
      // Only thread 0 allocates registrations, after installing their metadata.
      Atomics.add(new Int32Array(record.generation), 4, 1);
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
    fact.revision === Atomics.load(cell, fact.schemaDependent ? 0 : 1)
  );
}
