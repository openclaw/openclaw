import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import {
  AgentDatabaseSchemaAdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError,
} from "./agent-database-admission-error.js";
import {
  withReceiptFixture,
  independentWorkerReceipt,
  observeValidationPragmas,
} from "./agent-validation.test-support.js";
import {
  loadOpenClawAgentCanonicalValidationReceipt,
  recordOpenClawAgentCanonicalValidation,
} from "./openclaw-agent-canonical-validation-receipt.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  hasOpenClawAgentReadOnlySchema,
} from "./openclaw-agent-db-readonly-open.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { refreshOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema-refresh.js";
import {
  adoptOpenClawAgentDatabaseSchema,
  adoptOpenClawAgentDatabaseValidation,
  captureOpenClawAgentDatabaseAdmissionPublication,
  captureOpenClawAgentDatabaseAliasPublication,
  captureOpenClawAgentDatabaseReadValidation,
  captureOpenClawAgentDatabaseValidationTransfer,
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidationForTransfer,
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseSchema,
  invalidateOpenClawAgentCanonicalValidation,
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
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";

const observedValidationDirectories = vi.hoisted(
  () => [] as Array<{ directory: string; notify: (filename?: string) => void; active: boolean }>,
);
// mock-isolation: Drive identity invalidation deterministically without native watcher timing.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory(directory: string, notify: (filename?: string) => void) {
    const observer = { directory, notify, active: true };
    observedValidationDirectories.push(observer);
    return {
      close: () => {
        observer.active = false;
      },
    };
  },
}));

describe("canonical proof on physical database validation", () => {
  it.each(["observation", "reader admission"] as const)(
    "retains read validation across native close and detects replacement through %s",
    async (invalidation) => {
      await withReceiptFixture(false, (database) => {
        const captured = captureOpenClawAgentDatabaseReadValidation(database);
        expect(captured?.canonicalPath).toBe(database.path);
        const realpath = vi.spyOn(fs.realpathSync, "native");
        const stat = vi.spyOn(fs, "statSync");
        syncBuiltinESMExports();
        try {
          const warm = captureOpenClawAgentDatabaseReadValidation(database);
          expect(warm?.validation.receiptId).toBe(captured?.validation.receiptId);
          captured!.assertCurrent();
          warm!.assertCurrent();
          expect(realpath).not.toHaveBeenCalled();
          expect(stat).not.toHaveBeenCalled();
        } finally {
          realpath.mockRestore();
          stat.mockRestore();
          syncBuiltinESMExports();
        }
        closeOpenClawAgentDatabaseByPath(database.path);
        expect(
          observedValidationDirectories.some(
            (observer) => observer.active && observer.directory === path.dirname(database.path),
          ),
        ).toBe(true);
        expect(captureOpenClawAgentDatabaseReadValidation(database)?.validation.receiptId).toBe(
          captured?.validation.receiptId,
        );
        const replacement = `${database.path}.replacement`;
        fs.copyFileSync(database.path, replacement);
        fs.renameSync(replacement, database.path);
        expect(Atomics.load(new Int32Array(captured!.validation.valid), 0)).toBe(1);
        expect(captureOpenClawAgentDatabaseReadValidation(database)?.validation.receiptId).toBe(
          captured?.validation.receiptId,
        );
        if (invalidation === "reader admission") {
          expect(captureOpenClawAgentDatabaseReadValidation(database, "admission")).toBeUndefined();
        } else {
          for (const observer of observedValidationDirectories) {
            if (observer.active && observer.directory === path.dirname(database.path)) {
              observer.notify(path.basename(database.path));
            }
          }
        }
        expect(() => captured!.assertCurrent()).toThrow(
          "Session reader validation is no longer current",
        );
        expect(Atomics.load(new Int32Array(captured!.validation.valid), 0)).toBe(0);
        expect(
          observedValidationDirectories.some(
            (observer) => observer.active && observer.directory === path.dirname(database.path),
          ),
        ).toBe(false);
      });
    },
  );

  it("rejects a replaced file at receiver and queued write admission before observation", async () => {
    await withReceiptFixture(false, async (database, options) => {
      const captured = captureOpenClawAgentDatabaseReadValidation(database)!;
      closeOpenClawAgentDatabaseByPath(database.path);
      const entered = createDeferred();
      const resume = createDeferred();
      const first = runOpenClawAgentWriteAdmission(options, async () => {
        entered.resolve();
        await resume.promise;
      });
      await entered.promise;
      let effect = false;
      const queued = runOpenClawAgentWriteAdmission(options, () => {
        effect = true;
      });
      void queued.catch(() => undefined);
      try {
        const replacement = `${database.path}.replacement`;
        fs.copyFileSync(database.path, replacement);
        fs.renameSync(replacement, database.path);
        const opened = openOpenClawAgentDatabaseReadOnly(options);
        expect(opened.found).toBe(true);
        if (opened.found) {
          try {
            expect(adoptOpenClawAgentDatabaseValidation(opened.database, captured.validation)).toBe(
              false,
            );
          } finally {
            opened.database.close();
          }
        }
        resume.resolve();
        await first;
        await expect(queued).rejects.toThrow(
          "Agent database target changed before write admission",
        );
        expect(effect).toBe(false);
      } finally {
        resume.resolve();
        await Promise.allSettled([first, queued]);
      }
    });
  });
  it("shares republished schema proof with restart readers through a directory symlink", async () => {
    await withReceiptFixture(true, (database) => {
      const aliasDir = path.join(path.dirname(database.path), "reader-alias");
      fs.symlinkSync(path.dirname(database.path), aliasDir, "junction");
      const alias = {
        agentId: database.agentId,
        path: path.join(aliasDir, path.basename(database.path)),
      };
      const reader = captureOpenClawAgentDatabaseReadValidation(alias);
      expect(reader).toBeDefined();
      const receipt = getOpenClawAgentDatabaseValidation(database)!;
      const delayed = structuredClone(receipt);
      const valid = receipt.schema!.valid;
      const publish = captureOpenClawAgentDatabaseAdmissionPublication(alias);
      publishOpenClawAgentDatabaseSchema(database);
      expect(receipt.schema!.valid).toBe(valid);
      publish(delayed.identity, delayed);
      expect(() => reader!.assertCurrent()).not.toThrow();
      expect(getOpenClawAgentDatabaseValidationForTransfer(alias)).toBe(receipt);
      expect(alias.path).toContain("reader-alias");
      invalidateOpenClawAgentDatabaseValidation(database.path);
      expect(() => reader!.assertCurrent()).toThrow(
        "Session reader validation is no longer current",
      );
    });
  });

  it("shares admitted schema without marker queries while retaining explicit revocation", async () => {
    await withReceiptFixture(false, (database, options) => {
      const warm = observeValidationPragmas(database.db);
      try {
        runSqliteReadOperationSync(database.db, () => {
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(true);
        });
        expect(warm.counts).toEqual({ data_version: 0, schema_version: 0, user_version: 0 });
        database.db.exec("BEGIN");
        try {
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
          expect(warm.counts).toEqual({ data_version: 0, schema_version: 0, user_version: 0 });
        } finally {
          database.db.exec("COMMIT");
        }
        expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(true);
        expect(warm.counts).toEqual({ data_version: 0, schema_version: 0, user_version: 0 });
      } finally {
        warm.restore();
      }

      const reader = openOpenClawAgentDatabaseReadOnly(options);
      if (!reader.found || isPostgresSqlConnection(reader.database.db)) {
        throw new Error("Expected independent SQLite reader");
      }
      const cold = observeValidationPragmas(reader.database.db);
      try {
        expect(adoptOpenClawAgentDatabaseSchema(reader.database)).toBe(true);
        expect(cold.counts).toEqual({ data_version: 0, schema_version: 0, user_version: 0 });
        runSqliteReadOperationSync(reader.database.db, () =>
          expect(adoptOpenClawAgentDatabaseSchema(reader.database)).toBe(true),
        );
        expect(cold.counts).toEqual({ data_version: 0, schema_version: 0, user_version: 0 });
      } finally {
        cold.restore();
        reader.database.close();
      }

      const writer = new DatabaseSync(database.path);
      try {
        writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
        const observation = observeValidationPragmas(database.db);
        try {
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);
          expect(observation.counts.schema_version).toBe(0);
          expect(observation.counts.user_version).toBe(0);
        } finally {
          observation.restore();
        }
      } finally {
        writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
        writer.close();
      }
      invalidateOpenClawAgentDatabaseSchema(database);
      expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
    });
  });

  it("repairs missing additive schema during refresh without losing existing sessions", async () => {
    await withReceiptFixture(true, (database, options) => {
      const reader = openOpenClawAgentDatabaseReadOnly(options);
      if (!reader.found) {
        throw new Error("Expected independent reader");
      }
      const previousFacts = getOpenClawAgentDatabaseValidation(database)?.schema?.facts;
      assert(previousFacts, "Expected native schema facts before refresh");
      const previousSchemaVersion = previousFacts.schemaVersion;
      try {
        database.db.exec("DROP TABLE session_reactions");
        expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);

        refreshOpenClawAgentDatabaseSchema(database, () => {});

        expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
        const published = getAdmittedSqliteSchemaFacts(reader.database.db);
        expect(published?.schemaVersion).toBeGreaterThan(previousSchemaVersion);
        expect(published?.tables.has("session_reactions")).toBe(true);
        expect(
          reader.database.db.prepare("SELECT message_id FROM session_reactions").all(),
        ).toEqual([]);
        expect(
          reader.database.db
            .prepare(
              "SELECT current_session_id, entry_json, updated_at FROM session_nodes WHERE session_key = ?",
            )
            .get("agent:main:existing"),
        ).toEqual({
          current_session_id: "existing",
          entry_json: '{"sessionId":"existing","updatedAt":1}',
          updated_at: 1,
        });
      } finally {
        reader.database.close();
      }
    });
  });

  it.each(["refreshed", "replacement"] as const)(
    "shares %s proof published after local DDL without rechecking foreign schema markers",
    async (receipt) => {
      await withReceiptFixture(false, (database, options) => {
        const reader = openOpenClawAgentDatabaseReadOnly(options);
        if (!reader.found) {
          throw new Error("Expected independent reader");
        }
        expect(hasOpenClawAgentCanonicalValidation(reader.database)).toBe(true);
        const original = getOpenClawAgentDatabaseValidation(database)!.schema!;
        publishOpenClawAgentDatabaseSchema(database);
        const foreign = new DatabaseSync(database.path);
        try {
          database.db.exec("CREATE TABLE late_reader_fixture(value TEXT)");
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
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
          expect(
            getOpenClawAgentDatabaseValidation(database)?.schema?.facts?.tables.has(
              "late_reader_fixture",
            ),
          ).toBe(true);

          // TEMP changes preserve MAIN admission; durable DDL still revokes it.
          reader.database.db.exec("CREATE TEMP TABLE local_fixture(value TEXT)");
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(true);
          database.db.exec("CREATE TABLE main.local_fixture(value TEXT)");
          expect(adoptOpenClawAgentDatabaseSchema(database)).toBe(false);
          refreshOpenClawAgentDatabaseSchema(database, () => {});
          expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);

          foreign.exec("CREATE TABLE later_foreign_fixture(value TEXT)");
          expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);

          foreign.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
          expect(hasOpenClawAgentReadOnlySchema(reader.database)).toBe(true);
          expect(adoptOpenClawAgentDatabaseSchema(database, true, true)).toBe(true);
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
        const blockedDirectory = path.join(source.dir, "not-a-directory");
        fs.writeFileSync(blockedDirectory, "synthetic non-directory");
        const candidates = [
          { path: path.join(blockedDirectory, "unreadable.sqlite") },
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
            { ...received, schema: undefined },
          ]) {
            expect(() => publish(received.identity, malformed), race).toThrow(
              AgentDatabaseSchemaAdmissionInvalidError,
            );
          }
        }
      });
    });

    it.each([
      { cache: "canonical", transition: "promotion" },
      { cache: "empty", transition: "promotion" },
      { cache: "empty", transition: "replacement" },
      { cache: "canonical", transition: "invalidation" },
      { cache: "canonical", transition: "registration" },
    ] as const)(
      "preserves publication custody across $cache admission $transition",
      async ({ cache, transition }) => {
        await withReceiptFixture(true, (database, options) => {
          runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
          const received = independentWorkerReceipt(database);
          closeOpenClawAgentDatabaseByPath(database.path);
          clearOpenClawAgentDatabaseValidationCache(database.path);
          revokeSqliteDatabaseAdmissionsForPath(database.path);
          const reader = openOpenClawAgentDatabaseReadOnly(options);
          if (!reader.found || !received.schema) {
            throw new Error("Expected a canonical reader and an independently admitted receipt");
          }
          try {
            // Native fixture supplies the cold read-admission step performed by the worker.
            loadOpenClawAgentCanonicalValidationReceipt(reader.database);
            expect(hasOpenClawAgentCanonicalValidation(reader.database)).toBe(true);
            if (cache === "empty") {
              clearOpenClawAgentDatabaseValidationCache(database.path);
            }
            expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
            const publish = captureOpenClawAgentDatabaseAdmissionPublication(database);
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
            if (transition === "replacement") {
              expect(promoted.identity).not.toBe(received.identity);
            }
            expect(Atomics.load(new Int32Array(received.valid), 0)).toBe(1);
            expect(Atomics.load(new Int32Array(received.schema.valid), 0)).toBe(1);
            if (transition === "promotion") {
              expect(() => publish(received.identity, received)).not.toThrow();
            } else {
              expect(() => publish(received.identity, received)).toThrow(
                AgentDatabaseSchemaAdmissionChangedError,
              );
            }
            expect(Atomics.load(new Int32Array(promoted.valid), 0)).toBe(1);
            expect(adoptOpenClawAgentDatabaseSchema(reopened, true, true)).toBe(true);
            invalidateOpenClawAgentDatabaseSchema(reopened);
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
          invalidateOpenClawAgentCanonicalValidation(database);
          expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
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

  it.each(["commit", "rollback"] as const)(
    "revokes canonical receipts for offline repair while retaining integrity (%s)",
    async (outcome) => {
      await withReceiptFixture(true, (database, options) => {
        runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
        expect(markOpenClawAgentCanonicalValidation(database)).toBe(true);
        const physical = getOpenClawAgentDatabaseValidation(database);
        const mutate = () =>
          runOpenClawAgentWriteTransaction((current) => {
            invalidateOpenClawAgentCanonicalValidation(current);
            expect(hasOpenClawAgentCanonicalValidation(current)).toBe(false);
            expect(
              current.db.prepare("SELECT canonical_ready FROM session_key_contract").get()
                ?.canonical_ready,
            ).toBeNull();
            if (outcome === "rollback") {
              throw new Error("undo repair");
            }
          }, options);
        if (outcome === "rollback") {
          expect(mutate).toThrow("undo repair");
        } else {
          mutate();
        }
        expect(hasOpenClawAgentCanonicalValidation(database)).toBe(false);
        expect(getOpenClawAgentDatabaseValidation(database)).toBe(physical);
        expect(Atomics.load(new Int32Array(physical!.valid), 0)).toBe(1);
        const stored = database.db
          .prepare("SELECT canonical_ready FROM session_key_contract")
          .get()?.canonical_ready;
        expect(stored === null).toBe(outcome === "commit");
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
