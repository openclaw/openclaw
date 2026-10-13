import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sqliteDatabaseSealSchemaFor } from "../state/openclaw-database-seal-schema.js";
import {
  invalidateSqliteCleanCloseSeal,
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "./sqlite-clean-close-seal.js";
import {
  SqliteDatabaseGenerationSlot,
  readSqliteDatabaseAdmissionIdentity as identity,
  readSqliteDatabaseFactRevision,
  readSqliteDatabaseGeneration,
  isSqliteDatabaseAdmissionFactCurrent as valid,
  type Admission,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission-record.js";

const SQLITE_DATABASE_SEAL_SCHEMA = sqliteDatabaseSealSchemaFor();

export const integrityVerificationKey: SqliteDatabaseAdmissionKey<number> = {
  name: "sqlite.full-verification",
  read: (value) => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined),
};

// Only completed validation facts cross a restart. Row caches and live authority
// are deliberately excluded; their owners reconstruct them from current state.
const sealedKeys = new Set([
  "sqlite-schema",
  "sqlite.full-verification",
  "state.schema-version",
  "state.runtime-schema",
  "state.integrity",
  "agent.completed-validation",
  "agent.canonical-validation-receipt",
  "agent.schema-metadata",
]);

function isSealedKey(name: string): boolean {
  // Memory's completed schema proof is keyed by cache/FTS options and revoked by DDL.
  return sealedKeys.has(name) || name.startsWith("memory.index-schema:");
}

function encodeSealValue(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { sealType: "map", entries: [...value] };
  }
  if (value instanceof Set) {
    return { sealType: "set", entries: [...value] };
  }
  if (value instanceof SharedArrayBuffer) {
    return { sealType: "shared", entries: [...new Int32Array(value)] };
  }
  return value;
}

function decodeSealValue(_key: string, value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return value;
  }
  if (value.sealType === "map") {
    return new Map(value.entries);
  }
  if (value.sealType === "set") {
    return new Set(value.entries);
  }
  if (value.sealType === "shared") {
    const shared = new SharedArrayBuffer(value.entries.length * Int32Array.BYTES_PER_ELEMENT);
    new Int32Array(shared).set(value.entries);
    return shared;
  }
  return value;
}

export class SqliteDatabaseCleanCloseSeals {
  private readonly loaded = new WeakSet<Admission>();

  constructor(
    private readonly publishFact: (
      record: Admission,
      key: Pick<SqliteDatabaseAdmissionKey<unknown>, "name" | "schemaDependent">,
      value: unknown,
      revision: number,
    ) => void,
    private readonly references: {
      retain: (record: Admission) => void;
      release: (record: Admission) => void;
    },
  ) {}

  markCreated(record: Admission): void {
    this.loaded.add(record);
  }

  load(record: Admission): void {
    // Only descriptor custody can admit restart proof. Workers consume the host's
    // shared facts; rereading a seal there could revive an explicitly revoked fact.
    if (threadId !== 0) {
      return;
    }
    if (this.loaded.has(record)) {
      return;
    }
    this.loaded.add(record);
    const seal = readSqliteCleanCloseSeal(
      record.location,
      SQLITE_DATABASE_SEAL_SCHEMA,
      fs.fstatSync(record.descriptor, { bigint: true }),
    );
    if (!seal || typeof seal.facts !== "string") {
      return;
    }
    try {
      const facts: unknown = JSON.parse(seal.facts, decodeSealValue);
      if (
        !Array.isArray(facts) ||
        !facts.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 3 &&
            typeof entry[0] === "string" &&
            isSealedKey(entry[0]) &&
            typeof entry[1] === "boolean",
        ) ||
        !facts.some(
          ([name, , value]) => name === integrityVerificationKey.name && value === seal.verifiedAt,
        ) ||
        !facts.some(([name, , value]) => name === "sqlite-schema" && isRecord(value))
      ) {
        return;
      }
      for (const [name, schemaDependent, value] of facts) {
        this.publishFact(
          record,
          { name, schemaDependent },
          value,
          readSqliteDatabaseFactRevision(record, schemaDependent),
        );
      }
      Atomics.store(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.sealPresent, 1);
    } catch {
      // A complete envelope with unusable facts is still a cache miss.
    }
  }

  invalidate(location: string, record?: Admission): void {
    invalidateSqliteCleanCloseSeal(record?.location ?? location);
    if (record) {
      Atomics.store(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.sealPresent, 0);
    }
  }

  prepare(
    database: DatabaseSync,
    record: Admission | undefined,
    verifiedAt: number | undefined,
  ): Disposable & { publish(this: void): boolean } {
    const publish = this.preparePublication(database, record, verifiedAt);
    if (record) {
      // Native close must not retire this generation before its seal is published.
      this.references.retain(record);
    }
    let retained = record;
    return {
      publish: () => retained !== undefined && publish(),
      [Symbol.dispose]: () => {
        const released = retained;
        retained = undefined;
        if (released) {
          this.references.release(released);
        }
      },
    };
  }

  private preparePublication(
    database: DatabaseSync,
    record: Admission | undefined,
    verifiedAt: number | undefined,
  ): () => boolean {
    if (!record || database.isTransaction) {
      return () => false;
    }
    if (verifiedAt === undefined) {
      return () => false;
    }
    const facts = [...record.facts].filter(
      ([name, fact]) => isSealedKey(name) && valid(record, fact),
    );
    if (!facts.some(([name]) => name === "sqlite-schema")) {
      return () => false;
    }
    const serialized = JSON.stringify(
      facts.map(([name, fact]) => [name, fact.schemaDependent, fact.value]),
      encodeSealValue,
    );
    return () => {
      if (
        database.isOpen ||
        readSqliteDatabaseGeneration(record, "retired") !== 0 ||
        facts.some(
          ([, fact]) =>
            Atomics.load(new Int32Array(fact.current), 0) !== 1 ||
            fact.revision !== readSqliteDatabaseFactRevision(record, fact.schemaDependent),
        )
      ) {
        return false;
      }
      try {
        const file = fs.fstatSync(record.descriptor, { bigint: true });
        if (identity(fs.statSync(record.location, { bigint: true })) !== record.identity) {
          return false;
        }
        const written = writeSqliteCleanCloseSeal(
          record.location,
          SQLITE_DATABASE_SEAL_SCHEMA,
          file,
          { verifiedAt, facts: serialized },
        );
        Atomics.store(
          new Int32Array(record.generation),
          SqliteDatabaseGenerationSlot.sealPresent,
          written ? 1 : 0,
        );
        return written;
      } catch {
        // Sealing is an optimization after successful native disposal.
        return false;
      }
    };
  }
}
