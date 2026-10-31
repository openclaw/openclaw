import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasPendingAgentStartupColumns } from "../state/openclaw-agent-db-additive-columns.js";
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
  type AdmissionFactValue,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission-record.js";

const sealSchemas: Partial<
  Record<"agent" | "state" | "other", ReturnType<typeof sqliteDatabaseSealSchemaFor>>
> = {};

function sealSchema(names: string[]) {
  const agent = names.includes("agent.schema-metadata");
  const state = names.includes("state.schema-version");
  // Custom paths cannot identify the database family. Its admitted facts can;
  // unknown or mixed catalogs conservatively depend on both schemas.
  const kind = agent === state ? "other" : agent ? "agent" : "state";
  // The native runtime probe must finish before a storage identity can be cached.
  return (sealSchemas[kind] ??= sqliteDatabaseSealSchemaFor(kind));
}

export const integrityVerificationKey: SqliteDatabaseAdmissionKey<number> = {
  name: "sqlite.full-verification",
  lifetime: "process",
  read: (value) => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined),
};

// Recovery QUICK may survive an orderly close without claiming a FULL verification.
export const quickIntegrityVerificationKey: SqliteDatabaseAdmissionKey<number> = {
  ...integrityVerificationKey,
  name: "sqlite.quick-verification",
};

// Only completed validation facts cross a restart. Row caches and live authority
// are deliberately excluded; their owners reconstruct them from current state.
const sealedKeys = new Set([
  "sqlite-schema",
  "sqlite.full-verification",
  "sqlite.quick-verification",
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
      key: Pick<SqliteDatabaseAdmissionKey<unknown>, "name" | "schemaDependent" | "lifetime">,
      value: AdmissionFactValue,
      revision: number,
    ) => void,
    private readonly references: {
      retain: (record: Admission) => void;
      release: (record: Admission) => void;
      publish: (record: Admission) => void;
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
    record.cleanCloseRefusal = "malformed-proof";
    try {
      const seal = readSqliteCleanCloseSeal(
        record.location,
        fs.fstatSync(record.descriptor, { bigint: true }),
        (reason) => {
          record.cleanCloseRefusal = reason;
        },
      );
      if (!seal || typeof seal.facts !== "string") {
        return;
      }
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
          ([name, , value]) =>
            (name === integrityVerificationKey.name ||
              name === quickIntegrityVerificationKey.name) &&
            value === seal.verifiedAt,
        ) ||
        !facts.some(([name, , value]) => name === "sqlite-schema" && isRecord(value))
      ) {
        return;
      }
      const expected = sealSchema(facts.map(([name]) => name));
      if (!expected) {
        record.cleanCloseRefusal = "identity-mismatch";
        return;
      }
      const saved = seal.identity;
      if (
        saved !== undefined &&
        (!isRecord(saved) ||
          typeof saved.runtime !== "string" ||
          typeof saved.schema !== "string" ||
          typeof saved.policy !== "number")
      ) {
        return;
      }
      if (isRecord(saved) && typeof saved.sqlite !== "string") {
        if (
          !isRecord(saved.sqlite) ||
          typeof saved.sqlite.version !== "string" ||
          typeof saved.sqlite.sourceId !== "string" ||
          typeof saved.sqlite.compileOptions !== "string"
        ) {
          return;
        }
        // Version/source changes do not invalidate verified bytes. Compare every
        // compatibility component even when the runtime or library changed too.
        const schemaChanged = saved.schema !== expected.identity.schema;
        const policyChanged = saved.policy !== expected.identity.policy;
        const featuresChanged =
          saved.sqlite.compileOptions !== expected.identity.sqlite.compileOptions;
        if (schemaChanged || policyChanged || featuresChanged) {
          record.cleanCloseRefusal = schemaChanged
            ? "schema-mismatch"
            : policyChanged
              ? "policy-mismatch"
              : "feature-mismatch";
          return;
        }
      } else if (seal.schemaIdentity !== expected.schemaIdentity) {
        // Legacy combined hashes cannot prove unchanged features across upgrades.
        record.cleanCloseRefusal = "identity-mismatch";
        return;
      }
      const schema = facts.find(([name]) => name === "sqlite-schema")?.[2];
      // Reject old completed-validation receipts before publishing any reader-visible facts.
      if (!(schema.tableSql instanceof Map)) {
        return;
      }
      if (hasPendingAgentStartupColumns(schema.tableSql)) {
        record.cleanCloseRefusal = "schema-mismatch";
        return;
      }
      delete record.cleanCloseRefusal;
      for (const [name, schemaDependent, value] of facts) {
        this.publishFact(
          record,
          { name, schemaDependent, lifetime: "process" },
          { value },
          readSqliteDatabaseFactRevision(record, schemaDependent),
        );
      }
      Atomics.store(new Int32Array(record.generation), SqliteDatabaseGenerationSlot.sealPresent, 1);
    } catch {
      // A complete envelope with unusable facts is still a cache miss.
    } finally {
      this.references.publish(record);
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
    const schema = sealSchema(facts.map(([name]) => name));
    if (!schema) {
      return () => false;
    }
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
        const written = writeSqliteCleanCloseSeal(record.location, schema.schemaIdentity, file, {
          verifiedAt,
          facts: serialized,
          identity: schema.identity,
        });
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
