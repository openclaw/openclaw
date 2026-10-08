import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  AgentDatabaseSchemaAdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError,
} from "./agent-database-admission-error.js";
import { recordOpenClawAgentCanonicalValidation } from "./openclaw-agent-canonical-validation-receipt.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  hasOpenClawAgentReadOnlySchema,
} from "./openclaw-agent-db-readonly-open.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { refreshOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  adoptOpenClawAgentDatabaseSchema,
  adoptOpenClawAgentDatabaseValidation,
  captureOpenClawAgentDatabaseAdmissionPublication,
  captureOpenClawAgentDatabaseAliasPublication,
  captureOpenClawAgentDatabaseValidationTransfer,
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidationForTransfer,
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseSchema,
  invalidateOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidationsForAgent,
  markOpenClawAgentCanonicalValidation,
  publishOpenClawAgentDatabaseSchema,
  releaseOpenClawAgentDatabaseReadValidation,
  setOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";

async function withReceiptFixture(
  populated: boolean,
  run: (
    database: OpenClawAgentDatabase,
    options: OpenClawAgentDatabaseOptions,
  ) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    let database = openOpenClawAgentDatabase(options);
    if (populated) {
      database.db.exec(`INSERT INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:existing', 'existing', '{"sessionId":"existing","updatedAt":1}', 1);
        UPDATE session_nodes SET entry_valid = 1;
        DELETE FROM session_canonical_validation_pending;`);
      invalidateOpenClawAgentDatabaseValidation(database.path);
      closeOpenClawAgentDatabaseByPath(database.path);
      database = openOpenClawAgentDatabase(options);
    }
    await run(database, options);
  });
}

describe("canonical proof on physical database validation", () => {
  it("reuses admitted schema markers while preserving foreign changes and revocation", async () => {
    await withReceiptFixture(false, (database, options) => {
      const observe = (db: DatabaseSync) =>
        trackSqliteStatementExecutions(
          db,
          ["data_version", "schema_version", "user_version"],
          (sql) => {
            if (/FROM main\.pragma_data_version\(\)\s*$/iu.test(sql)) {
              return "data_version";
            }
            const name = /^PRAGMA (data_version|schema_version|user_version);?$/iu.exec(sql)?.[1];
            return name === "data_version" || name === "schema_version" || name === "user_version"
              ? name
              : null;
          },
        );
      const warm = observe(database.db);
      try {
        runSqliteReadOperationSync(
          database.db,
          () => {
            expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(true);
            expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(true);
          },
          "fresh",
        );
        expect(warm.counts).toEqual({ data_version: 1, schema_version: 0, user_version: 0 });
        database.db.exec("BEGIN");
        try {
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
          expect(warm.counts).toEqual({ data_version: 1, schema_version: 0, user_version: 0 });
        } finally {
          database.db.exec("ROLLBACK");
        }
      } finally {
        warm.restore();
      }

      const reader = openOpenClawAgentDatabaseReadOnly(options);
      if (!reader.found) {
        throw new Error("Expected independent reader");
      }
      const cold = observe(reader.database.db);
      try {
        expect(adoptOpenClawAgentDatabaseSchema(reader.database)).toBe(true);
        expect(cold.counts).toEqual({ data_version: 1, schema_version: 1, user_version: 1 });
        runSqliteReadOperationSync(
          reader.database.db,
          () => expect(adoptOpenClawAgentDatabaseSchema(reader.database)).toBe(true),
          "fresh",
        );
        expect(cold.counts).toEqual({ data_version: 2, schema_version: 1, user_version: 1 });
      } finally {
        cold.restore();
        reader.database.close();
      }

      const writer = new DatabaseSync(database.path);
      try {
        writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
        expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
        expect(() => adoptOpenClawAgentDatabaseSchema(database, true, true)).toThrow(
          "Agent schema admission changed",
        );
      } finally {
        writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
        writer.close();
      }
      invalidateOpenClawAgentDatabaseSchema(database);
      expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
    });
  });

  it.each(["refreshed", "replacement"] as const)(
    "keeps %s proof when a retained reader observes the same foreign schema change",
    async (receipt) => {
      await withReceiptFixture(false, (database, options) => {
        const reader = openOpenClawAgentDatabaseReadOnly(options);
        if (!reader.found) {
          throw new Error("Expected independent reader");
        }
        expect(hasOpenClawAgentCanonicalValidation(reader.database)).toBe(true);
        const original = getOpenClawAgentDatabaseValidation(database)!.schema!;
        const foreign = new DatabaseSync(database.path);
        try {
          foreign.exec("CREATE TABLE late_reader_fixture(value TEXT)");
          refreshOpenClawAgentDatabaseSchema(database, () => {});
          if (receipt === "replacement") {
            invalidateOpenClawAgentDatabaseValidation(database.path);
            setOpenClawAgentDatabaseValidation(database);
          }
          expect(Atomics.load(new Int32Array(original.valid), 0)).toBe(0);
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);
          expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);
          expect(Atomics.load(new Int32Array(original.valid), 0)).toBe(0);

          // Local TEMP DDL still revokes even though main's schema markers do not change.
          reader.database.db.exec("CREATE TEMP TABLE local_fixture(value TEXT)");
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
          refreshOpenClawAgentDatabaseSchema(database, () => {});
          expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);

          foreign.exec("CREATE TABLE later_foreign_fixture(value TEXT)");
          expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
          refreshOpenClawAgentDatabaseSchema(database, () => {});
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);

          foreign.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
          expect(() => hasOpenClawAgentReadOnlySchema(reader.database)).toThrow(/newer schema/);
          expect(() => adoptOpenClawAgentDatabaseSchema(database, true, true)).toThrow(
            "Agent schema admission changed",
          );
        } finally {
          foreign.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
          foreign.close();
          reader.database.close();
        }
      });
    },
  );

  it.each(["durable receipt", "empty view"] as const)(
    "does not certify an uncommitted %s",
    async (proof) => {
      await withReceiptFixture(true, (database, options) => {
        expect(() =>
          runOpenClawAgentWriteTransaction((current) => {
            if (proof === "durable receipt") {
              recordOpenClawAgentCanonicalValidation(current);
              clearOpenClawAgentDatabaseValidationCache(current.path);
            } else {
              current.db.exec("DELETE FROM session_nodes");
              setOpenClawAgentDatabaseValidation(current);
            }
            expect(hasOpenClawAgentCanonicalValidation(current)).toBe(false);
            throw new Error("rollback proof");
          }, options),
        ).toThrow("rollback proof");
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
        if (proof === "durable receipt") {
          expect(
            database.db.prepare("SELECT canonical_ready FROM session_key_contract").get(),
          ).toEqual({ canonical_ready: null });
        } else {
          expect(
            database.db.prepare("SELECT current_session_id FROM session_nodes").get()
              ?.current_session_id,
          ).toBe("existing");
        }
      });
    },
  );

  function independentWorkerReceipt(database: OpenClawAgentDatabase) {
    const receipt = getOpenClawAgentDatabaseValidation(database);
    if (!receipt) {
      throw new Error("Expected physical validation receipt");
    }
    // A native first opener can establish proof before the host has any receipt.
    return {
      ...receipt,
      receiptId: randomUUID(),
      valid: receipt.valid.slice(0),
      canonicalReady: receipt.canonicalReady.slice(0),
    };
  }

  it.each(["exact", "sibling-family"] as const)(
    "releases closed reader metadata by %s without revoking parent proof or unselected aliases",
    async (selection) => {
      await withReceiptFixture(false, (database) => {
        const receipt = getOpenClawAgentDatabaseValidation(database)!;
        const source = path.parse(database.path);
        const family = path.join(source.dir, `${source.name}.secondary${source.ext}`);
        const sibling = path.join(source.dir, `${source.name}-other${source.ext}`);
        const alias = path.join(source.dir, `alias${source.ext}`);
        const target = (pathname: string) => ({ agentId: database.agentId, path: pathname });
        // These admitted locators share one physical receipt, as a worker's aliases can.
        for (const pathname of [family, sibling, alias]) {
          const adopt = captureOpenClawAgentDatabaseValidationTransfer(target(pathname));
          expect(adopt(receipt.identity, receipt)).toBe(true);
        }
        closeOpenClawAgentDatabaseByPath(database.path);
        const candidates = [
          { path: database.path, ...(selection === "sibling-family" ? { scope: selection } : {}) },
        ];

        releaseOpenClawAgentDatabaseReadValidation(candidates, [database.path]);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)?.valid).toBe(receipt.valid);
        releaseOpenClawAgentDatabaseReadValidation(candidates);

        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
        if (selection === "sibling-family") {
          expect(getOpenClawAgentDatabaseValidationForTransfer(target(family))).toBeUndefined();
        } else {
          expect(getOpenClawAgentDatabaseValidationForTransfer(target(family))?.valid).toBe(
            receipt.valid,
          );
        }
        for (const pathname of [sibling, alias]) {
          expect(getOpenClawAgentDatabaseValidationForTransfer(target(pathname))?.valid).toBe(
            receipt.valid,
          );
        }
        expect(Atomics.load(new Int32Array(receipt.valid), 0)).toBe(1);
        expect(Atomics.load(new Int32Array(receipt.canonicalReady), 0)).toBe(1);

        // A retired reader's path tombstone must not clear a later owner's ready receipt.
        invalidateOpenClawAgentDatabaseValidation(database.path);
        releaseOpenClawAgentDatabaseReadValidation(candidates);
        const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);
        expect(adopt(receipt.identity, receipt)).toBe(true);
        expect(Atomics.load(new Int32Array(receipt.canonicalReady), 0)).toBe(1);
      });
    },
  );

  describe("native integrity proof handoff", () => {
    it("distinguishes raced publication from malformed receipts even after revocation", async () => {
      await withReceiptFixture(false, (database) => {
        for (const race of ["capture", "captured proof", "received proof", "schema"] as const) {
          setOpenClawAgentDatabaseValidation(database);
          const original = getOpenClawAgentDatabaseValidation(database)!;
          const received = independentWorkerReceipt(database);
          const publish = captureOpenClawAgentDatabaseAdmissionPublication(database);
          if (race === "capture") {
            invalidateOpenClawAgentDatabaseValidation(database.path);
          } else {
            const cell =
              race === "captured proof"
                ? original.valid
                : race === "received proof"
                  ? received.valid
                  : received.schema!.valid;
            Atomics.store(new Int32Array(cell), 0, 0);
          }
          expect(() => publish(received.identity, received), race).toThrow(
            AgentDatabaseSchemaAdmissionChangedError,
          );
          if (race === "schema") {
            expect(original.schema && Atomics.load(new Int32Array(original.schema.valid), 0)).toBe(
              0,
            );
            expect(() => adoptOpenClawAgentDatabaseSchema(database, true, true)).toThrow(
              "Agent schema admission changed before handle adoption",
            );
          }
          for (const malformed of [
            undefined,
            { ...received, agentId: "another-agent" },
            { ...received, identity: "another-file" },
            { ...received, receiptId: undefined },
            { ...received, receiptId: "" },
            { ...received, receiptId: 1 },
            { ...received, valid: new SharedArrayBuffer(1) },
            { ...received, canonicalReady: new SharedArrayBuffer(1) },
            { ...received, schema: undefined },
            { ...received, schema: { ...received.schema, facts: {} } },
          ]) {
            expect(() => publish(received.identity, malformed), race).toThrow(
              AgentDatabaseSchemaAdmissionInvalidError,
            );
          }
        }
      });
    });

    it("preserves fresh schema admission when a superseded receipt is rejected", async () => {
      await withReceiptFixture(false, (database) => {
        const receipt = getOpenClawAgentDatabaseValidation(database);
        if (!receipt?.schema) {
          throw new Error("Expected the fixture's admitted schema receipt");
        }
        const delayed = structuredClone({ ...receipt, schema: receipt.schema });
        publishOpenClawAgentDatabaseSchema(database);
        expect(Atomics.load(new Int32Array(delayed.schema.valid), 0)).toBe(0);
        const schemaBefore = getOpenClawAgentDatabaseValidationForTransfer(database)?.schema;
        expect(schemaBefore && Atomics.load(new Int32Array(schemaBefore.valid), 0)).toBe(1);

        const publish = captureOpenClawAgentDatabaseAdmissionPublication(database);
        expect(() => publish(delayed.identity, delayed)).toThrow(
          AgentDatabaseSchemaAdmissionChangedError,
        );
        const schemaAfter = getOpenClawAgentDatabaseValidationForTransfer(database)?.schema;
        expect(schemaAfter && Atomics.load(new Int32Array(schemaAfter.valid), 0)).toBe(1);
        expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);
      });
    });

    it.each([
      { cache: "canonical", transition: "promotion" },
      { cache: "empty", transition: "promotion" },
      { cache: "empty", transition: "replacement" },
      { cache: "canonical", transition: "invalidation" },
      { cache: "canonical", transition: "registration" },
      { cache: "canonical", transition: "schema-revocation" },
      { cache: "empty", transition: "schema-revocation" },
      { cache: "canonical", transition: "local-ddl" },
      { cache: "empty", transition: "local-ddl" },
      { cache: "canonical", transition: "optional-schema-revocation" },
      { cache: "empty", transition: "optional-local-ddl" },
    ] as const)(
      "preserves publication custody across $cache admission $transition",
      async ({ cache, transition }) => {
        await withReceiptFixture(true, (database, options) => {
          runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
          const received = independentWorkerReceipt(database);
          closeOpenClawAgentDatabaseByPath(database.path);
          clearOpenClawAgentDatabaseValidationCache(database.path);
          const reader = openOpenClawAgentDatabaseReadOnly(options);
          if (!reader.found || !received.schema) {
            throw new Error("Expected a canonical reader and an independently admitted receipt");
          }
          try {
            expect(hasOpenClawAgentCanonicalValidation(reader.database)).toBe(true);
            if (cache === "empty") {
              clearOpenClawAgentDatabaseValidationCache(database.path);
            }
            expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
            const optional =
              transition === "optional-schema-revocation" || transition === "optional-local-ddl";
            const publish = optional
              ? captureOpenClawAgentDatabaseValidationTransfer(database)
              : captureOpenClawAgentDatabaseAdmissionPublication(database);
            if (transition === "invalidation") {
              invalidateOpenClawAgentDatabaseValidation(database.path);
            } else if (transition === "registration") {
              registerOpenClawAgentDatabase({ ...options, path: database.path });
            } else if (transition === "replacement") {
              reader.database.close();
              const replacement = `${database.path}.replacement`;
              fs.copyFileSync(database.path, replacement);
              fs.renameSync(replacement, database.path);
            }

            const reopened = openOpenClawAgentDatabase(options);
            const promoted = getOpenClawAgentDatabaseValidationForTransfer(reopened);
            if (!promoted?.schema) {
              throw new Error("Expected the full opener to publish schema admission");
            }
            const borrowed = structuredClone(promoted.schema);
            const schemaRevoked =
              transition === "schema-revocation" || transition === "local-ddl" || optional;
            if (transition === "schema-revocation" || transition === "optional-schema-revocation") {
              invalidateOpenClawAgentDatabaseSchema(reopened);
            } else if (transition === "local-ddl" || transition === "optional-local-ddl") {
              reopened.db.exec("CREATE TEMP TABLE revoked_promotion(value TEXT)");
            }
            if (transition === "replacement") {
              expect(promoted.identity).not.toBe(received.identity);
            }
            expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(1);
            expect(Atomics.load(new Int32Array(received.schema.valid), 0)).toBe(1);
            if (transition === "promotion") {
              expect(() => publish(received.identity, received)).not.toThrow();
            } else if (optional) {
              expect(publish(received.identity, received)).toBe(false);
            } else {
              expect(() => publish(received.identity, received)).toThrow(
                AgentDatabaseSchemaAdmissionChangedError,
              );
            }
            expect(Atomics.load(new Int32Array(promoted.valid), 0)).toBe(1);
            if (schemaRevoked) {
              expect(adoptOpenClawAgentDatabaseSchema(reopened)).toBe(false);
            } else {
              expect(adoptOpenClawAgentDatabaseSchema(reopened, true, true)).toBe(true);
              invalidateOpenClawAgentDatabaseSchema(reopened);
            }
            expect(Atomics.load(new Int32Array(borrowed.valid), 0)).toBe(0);
          } finally {
            reader.database.close();
          }
        });
      },
    );

    it.each(["required", "optional"] as const)(
      "accepts fresh %s readmission captured after schema revocation",
      async (mode) => {
        await withReceiptFixture(false, (database) => {
          const received = independentWorkerReceipt(database);
          if (!received.schema) {
            throw new Error("Expected independently checked schema facts");
          }
          received.schema = { ...received.schema, valid: new SharedArrayBuffer(4) };
          Atomics.store(new Int32Array(received.schema.valid), 0, 1);
          invalidateOpenClawAgentDatabaseSchema(database);
          const publish =
            mode === "required"
              ? captureOpenClawAgentDatabaseAdmissionPublication(database)
              : captureOpenClawAgentDatabaseValidationTransfer(database);
          expect(() => publish(received.identity, received)).not.toThrow();
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);
        });
      },
    );

    it.each(["revoked", "absent"] as const)(
      "retires borrowed schema when a native integrity receipt reports it %s",
      async (schemaState) => {
        await withReceiptFixture(false, (database) => {
          const receipt = getOpenClawAgentDatabaseValidation(database);
          if (!receipt?.schema) {
            throw new Error("Expected the fixture's admitted schema receipt");
          }
          const borrowed = structuredClone(receipt.schema);
          const received = {
            ...independentWorkerReceipt(database),
            schema:
              schemaState === "revoked"
                ? { ...receipt.schema, valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) }
                : undefined,
          };
          const publish = captureOpenClawAgentDatabaseValidationTransfer(database);
          expect(publish(received.identity, received)).toBe(true);
          expect(Atomics.load(new Int32Array(borrowed.valid), 0)).toBe(0);
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
        });
      },
    );

    it.each(["current", "revoked"] as const)(
      "preserves a %s native handoff while a reader publishes durable canonical proof",
      async (state) => {
        await withReceiptFixture(true, (database, options) => {
          runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
          const received = independentWorkerReceipt(database);
          clearOpenClawAgentDatabaseValidationCache(database.path);
          const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);

          expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
          expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
          if (state === "revoked") {
            invalidateOpenClawAgentDatabaseValidation(database.path);
          }

          expect(adopt(received.identity, received)).toBe(state === "current");
          expect(getOpenClawAgentDatabaseValidationForTransfer(database)?.valid).toBe(
            state === "current" ? received.valid : undefined,
          );
        });
      },
    );

    it("does not restore delayed proof after path, repeated, cache, or agent revocation", async () => {
      await withReceiptFixture(false, (database) => {
        const received = independentWorkerReceipt(database);
        clearOpenClawAgentDatabaseValidationCache(database.path);

        const beforeInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(beforeInvalidation(received.identity, received)).toBe(false);

        const beforeRepeatedInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(beforeRepeatedInvalidation(received.identity, received)).toBe(false);

        const beforeClear = captureOpenClawAgentDatabaseValidationTransfer(database);
        clearOpenClawAgentDatabaseValidationCache(database.path);
        expect(beforeClear(received.identity, received)).toBe(false);

        // A path can be revoked before its first native opener associates an agent.
        invalidateOpenClawAgentDatabaseValidation(database.path);
        const beforeAgentInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        invalidateOpenClawAgentDatabaseValidationsForAgent(database.agentId, []);
        expect(beforeAgentInvalidation(received.identity, received)).toBe(false);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
        expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(1);

        const afterInvalidation = captureOpenClawAgentDatabaseValidationTransfer(database);
        expect(afterInvalidation(received.identity, received)).toBe(true);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)?.valid).toBe(received.valid);
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);

        invalidateOpenClawAgentDatabaseValidation(database.path);
        const successor = { path: database.path, agentId: "successor" };
        const beforeOwnerRevocation = captureOpenClawAgentDatabaseValidationTransfer(successor);
        invalidateOpenClawAgentDatabaseValidationsForAgent(successor.agentId, []);
        const successorReceipt = {
          ...received,
          agentId: successor.agentId,
          identity: "successor-file",
          valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
        };
        Atomics.store(new Int32Array(successorReceipt.valid), 0, 1);
        expect(beforeOwnerRevocation(successorReceipt.identity, successorReceipt)).toBe(false);
      });
    });

    it("rejects delayed proof when a peer revokes the captured shared receipt", async () => {
      await withReceiptFixture(false, (database) => {
        const received = independentWorkerReceipt(database);
        const original = getOpenClawAgentDatabaseValidation(database)!;
        const peer = structuredClone(original);
        const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);

        Atomics.store(new Int32Array(peer.valid), 0, 0);

        expect(Atomics.load(new Int32Array(original.valid), 0)).toBe(0);
        expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(1);
        expect(adopt(received.identity, received)).toBe(false);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
      });
    });

    it.each(["superseded", "acknowledged"] as const)(
      "replaces revoked proof without leaking a live %s alias receipt",
      async (aliasState) => {
        await withReceiptFixture(false, (database) => {
          const original = getOpenClawAgentDatabaseValidation(database)!;
          const replacement = independentWorkerReceipt(database);
          const aliasReceipt =
            aliasState === "superseded"
              ? independentWorkerReceipt(database)
              : structuredClone(replacement);
          const alias = {
            agentId: database.agentId,
            path: path.join(path.dirname(database.path), "alias.sqlite"),
          };
          const acknowledgeAlias = captureOpenClawAgentDatabaseAdmissionPublication(alias);
          acknowledgeAlias(aliasReceipt.identity, aliasReceipt);
          // Worker lease cleanup revokes its transferred proof, not an independent alias.
          Atomics.store(new Int32Array(structuredClone(original).valid), 0, 0);
          const publish = captureOpenClawAgentDatabaseAdmissionPublication(database);

          publish(replacement.identity, structuredClone(replacement));

          expect(Atomics.load(new Int32Array(aliasReceipt.valid), 0)).toBe(
            aliasState === "superseded" ? 0 : 1,
          );
          expect(Atomics.load(new Int32Array(replacement.valid), 0)).toBe(1);
          for (const target of [database, alias]) {
            expect(getOpenClawAgentDatabaseValidationForTransfer(target)).toMatchObject({
              agentId: database.agentId,
              identity: replacement.identity,
            });
          }

          invalidateOpenClawAgentDatabaseValidation(alias.path);

          expect(Atomics.load(new Int32Array(replacement.valid), 0)).toBe(0);
          expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
          expect(getOpenClawAgentDatabaseValidationForTransfer(alias)).toBeUndefined();
        });
      },
    );

    it("rejects malformed receipt identities on an acknowledged alias", async () => {
      await withReceiptFixture(false, (database) => {
        const receipt = getOpenClawAgentDatabaseValidation(database)!;
        const publish = captureOpenClawAgentDatabaseAliasPublication(database);
        for (const receiptId of [undefined, "", 1]) {
          expect(() => publish(receipt.identity, { ...receipt, receiptId })).toThrow(
            AgentDatabaseSchemaAdmissionInvalidError,
          );
        }
        expect(Atomics.load(new Int32Array(receipt.valid), 0)).toBe(1);
        expect(() => publish(receipt.identity, receipt)).not.toThrow();
      });
    });

    it("accepts only valid native receipts without a host handle and shares revocation", async () => {
      await withReceiptFixture(false, (database) => {
        const received = independentWorkerReceipt(database);
        closeOpenClawAgentDatabaseByPath(database.path);
        clearOpenClawAgentDatabaseValidationCache(database.path);
        const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);
        for (const invalid of [
          { ...received, agentId: "another-agent" },
          { ...received, identity: "another-file" },
          { ...received, valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) },
          { ...received, valid: new SharedArrayBuffer(1) },
          { ...received, valid: new ArrayBuffer(Int32Array.BYTES_PER_ELEMENT) },
          { ...received, canonicalReady: new SharedArrayBuffer(1) },
        ]) {
          expect(adopt(received.identity, invalid)).toBe(false);
          expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
        }
        expect(adopt(received.identity, received)).toBe(true);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)?.valid).toBe(received.valid);
        invalidateOpenClawAgentDatabaseValidation(database.path);
        expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(0);
        expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
      });
    });
  });

  it.each([
    { cache: "warm", admission: "set" },
    { cache: "cold", admission: "adopt" },
  ] as const)(
    "does not revive revoked canonical proof on $cache integrity admission by $admission",
    async ({ cache, admission }) => {
      await withReceiptFixture(true, (database, options) => {
        runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        const receipt = getOpenClawAgentDatabaseValidation(database);
        if (!receipt) {
          throw new Error("Expected physical validation receipt");
        }
        // A separate worker can retain independent proof for this same physical file.
        const transferred = {
          ...receipt,
          receiptId: randomUUID(),
          valid: receipt.valid.slice(0),
          canonicalReady: receipt.canonicalReady.slice(0),
        };
        if (cache === "cold") {
          clearOpenClawAgentDatabaseValidationCache(database.path);
        }
        invalidateOpenClawAgentDatabaseValidation(database.path);
        if (admission === "adopt") {
          expect(adoptOpenClawAgentDatabaseValidation(database, transferred)).toBe(true);
          expect(getOpenClawAgentDatabaseValidation(database)).toBe(transferred);
        } else {
          setOpenClawAgentDatabaseValidation(database);
          expect(getOpenClawAgentDatabaseValidation(database)).toBeDefined();
        }
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
        if (admission === "adopt") {
          expect(Atomics.load(new Int32Array(transferred.canonicalReady), 0)).toBe(1);
        }
      });
    },
  );

  it.each(["empty", "populated", "pending", "durable handoff"] as const)(
    "initializes readiness from committed %s state",
    async (state) => {
      await withReceiptFixture(state === "populated", (database, options) => {
        if (state === "pending") {
          database.db
            .prepare("INSERT INTO session_canonical_validation_pending (session_key) VALUES (?)")
            .run("agent:main:unresolved");
          setOpenClawAgentDatabaseValidation(database);
        } else if (state === "durable handoff") {
          runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
          clearOpenClawAgentDatabaseValidationCache(database.path);
          captureOpenClawAgentDatabaseValidationTransfer(database);
        }
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(
          state === "empty" || state === "durable handoff",
        );
        if (state === "durable handoff") {
          expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
        }
      });
    },
  );

  it.each(["thin", "transferred"] as const)(
    "shares proof with %s readers but never raw readers",
    async (mode) => {
      await withReceiptFixture(true, (database, options) => {
        const raw = new DatabaseSync(database.path, { readOnly: true });
        try {
          expect(hasOpenClawAgentCanonicalValidation({ agentId: "main", db: raw })).toBe(false);
          expect(markOpenClawAgentCanonicalValidation({ agentId: "main", db: raw })).toBe(false);
          const opened = openOpenClawAgentDatabaseReadOnly(options);
          if (!opened.found) {
            throw new Error("Expected readonly fixture database");
          }
          try {
            const receipt = getOpenClawAgentDatabaseValidation(database);
            if (!receipt) {
              throw new Error("Expected physical validation receipt");
            }
            const transferred = structuredClone(receipt);
            if (mode === "transferred") {
              expect(adoptOpenClawAgentDatabaseValidation(opened.database, transferred)).toBe(true);
            }
            expect(
              markOpenClawAgentCanonicalValidation(
                mode === "thin" ? { agentId: "main", db: opened.database.db } : opened.database,
              ),
            ).toBe(true);
            expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
            expect(
              hasOpenClawAgentCanonicalValidation({ agentId: "other", db: opened.database.db }),
            ).toBe(false);
            expect(Atomics.load(new Int32Array(transferred.canonicalReady), 0)).toBe(1);
            if (mode === "transferred") {
              invalidateOpenClawAgentDatabaseValidation(database.path);
              expect(adoptOpenClawAgentDatabaseValidation(opened.database, transferred)).toBe(
                false,
              );
              expect(hasOpenClawAgentCanonicalValidation(opened.database)).toBe(false);
            }
          } finally {
            opened.database.close();
          }
          expect(hasOpenClawAgentCanonicalValidation(database)).toBe(mode === "thin");
          expect(hasOpenClawAgentCanonicalValidation({ agentId: "main", db: raw })).toBe(false);
        } finally {
          raw.close();
        }
      });
    },
  );

  it.each(["nested commit", "outer rollback", "savepoint rollback", "manual", "revoked"] as const)(
    "publishes transaction proof only with a valid owned commit (%s)",
    async (outcome) => {
      await withReceiptFixture(true, (database, options) => {
        const publish = () =>
          runOpenClawAgentWriteTransaction((current) => {
            expect(markOpenClawAgentCanonicalValidation(current)).toBe(true);
            if (outcome === "revoked") {
              invalidateOpenClawAgentDatabaseValidation(current.path);
              setOpenClawAgentDatabaseValidation(current);
            } else if (outcome === "nested commit") {
              expect(hasOpenClawAgentCanonicalValidation(current)).toBe(false);
            } else {
              throw new Error("rollback proof");
            }
          }, options);
        if (outcome === "manual") {
          database.db.exec("BEGIN IMMEDIATE");
          expect(markOpenClawAgentCanonicalValidation(database)).toBe(false);
          database.db.exec("COMMIT");
        } else if (outcome === "outer rollback") {
          expect(publish).toThrow("rollback proof");
        } else if (outcome === "revoked") {
          publish();
        } else {
          runOpenClawAgentWriteTransaction(() => {
            if (outcome === "savepoint rollback") {
              expect(publish).toThrow("rollback proof");
            } else {
              publish();
              expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
            }
          }, options);
        }
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(outcome === "nested commit");
      });
    },
  );

  it.each(["native close", "native dispose", "owner close"] as const)(
    "retains proof across %s and reopen",
    async (action) => {
      await withReceiptFixture(true, (database, options) => {
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        const receipt = getOpenClawAgentDatabaseValidation(database);
        if (action === "native close") {
          database.db.close();
        } else if (action === "native dispose") {
          database.db[Symbol.dispose]();
        } else {
          closeOpenClawAgentDatabaseByPath(database.path);
        }
        const reopened = openOpenClawAgentDatabase(options);
        expect(getOpenClawAgentDatabaseValidation(reopened) === receipt).toBe(true);
        expect(hasOpenClawAgentCanonicalValidation(reopened)).toBe(true);
      });
    },
  );

  it
    .runIf(typeof DatabaseSync.prototype.deserialize === "function")
    .each(["integrity proof", "canonical enrichment"] as const)(
    "revokes delayed %s on a failed native replacement attempt",
    async (proof) => {
      await withReceiptFixture(true, (database, options) => {
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        const received = independentWorkerReceipt(database);
        if (proof === "canonical enrichment") {
          runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
          clearOpenClawAgentDatabaseValidationCache(database.path);
        }
        const adopt = captureOpenClawAgentDatabaseValidationTransfer(database);
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(true);
        const serialized = database.db.serialize();
        database.db.exec("BEGIN IMMEDIATE");
        try {
          database.db.prepare("SELECT session_key FROM session_nodes").get();
          expect(() => database.db.deserialize(serialized)).toThrow();
          expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
          expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
          expect(adopt(received.identity, received)).toBe(false);
        } finally {
          database.db.exec("ROLLBACK");
        }
        const fresh = captureOpenClawAgentDatabaseValidationTransfer(database);
        expect(fresh(received.identity, received)).toBe(true);
      });
    },
  );
});
