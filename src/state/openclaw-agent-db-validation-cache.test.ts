import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, describe, expect, it as baseIt, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import {
  AgentDatabaseSchemaAdmissionChangedError as AdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError as AdmissionInvalidError,
} from "./agent-database-admission-error.js";
import { withReceiptFixture, independentWorkerReceipt } from "./agent-validation.test-support.js";
import {
  loadOpenClawAgentCanonicalValidationReceipt as loadCanonical,
  recordOpenClawAgentCanonicalValidation as recordCanonical,
} from "./openclaw-agent-canonical-validation-receipt.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  openOpenClawAgentDatabaseReadOnly as openReader,
  hasOpenClawAgentReadOnlySchema as hasReadSchema,
} from "./openclaw-agent-db-readonly-open.js";
import { registerOpenClawAgentDatabase as registerDatabase } from "./openclaw-agent-db-registry.js";
import { refreshOpenClawAgentDatabaseSchema as refreshSchema } from "./openclaw-agent-db-schema-refresh.js";
import {
  adoptOpenClawAgentDatabaseSchema as adoptSchema,
  adoptOpenClawAgentDatabaseValidation as adoptValidation,
  captureOpenClawAgentDatabaseAdmissionPublication as capturePublication,
  captureOpenClawAgentDatabaseAliasPublication as captureAliasPublication,
  captureOpenClawAgentDatabaseReadValidation as captureReadValidation,
  captureOpenClawAgentDatabaseValidationTransfer as captureTransfer,
  clearOpenClawAgentDatabaseValidationCache as clearValidation,
  getOpenClawAgentDatabaseValidation as getValidation,
  getOpenClawAgentDatabaseValidationForTransfer as getTransfer,
  hasOpenClawAgentCanonicalValidation as hasCanonical,
  invalidateOpenClawAgentDatabaseSchema as invalidateSchema,
  invalidateOpenClawAgentCanonicalValidation as invalidateCanonical,
  invalidateOpenClawAgentDatabaseValidation as invalidateValidation,
  invalidateOpenClawAgentDatabaseValidationsForAgent as invalidateAgent,
  markOpenClawAgentCanonicalValidation as markCanonical,
  publishOpenClawAgentDatabaseSchema as publishSchema,
  releaseOpenClawAgentDatabaseReadValidation as releaseReadValidation,
  setOpenClawAgentDatabaseValidation as setValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath as closePath,
  closeOpenClawAgentDatabasesAsync as closeDatabases,
  closeOpenClawAgentDatabasesForTest as retireFixture,
  openOpenClawAgentDatabase as openDatabase,
  runOpenClawAgentWriteTransaction as writeTransaction,
} from "./openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission as admitWrite } from "./openclaw-agent-write-admission.js";
import { expectRow, expectRows } from "./openclaw-state-db-fixtures.test-support.js";

const observedValidationDirectories = vi.hoisted(
  () =>
    [] as Array<{
      directory: string;
      notify: (filename?: string, event?: string) => void;
      active: boolean;
    }>,
);
type ReceiptRun = Parameters<typeof withReceiptFixture>[1];
type ReceiptOptions = Parameters<ReceiptRun>[1];
type ReceiptDatabase = Parameters<ReceiptRun>[0];
type ReceiptFixture = { database: ReceiptDatabase; options: ReceiptOptions };
const it = baseIt.extend<{ empty: ReceiptFixture; populated: ReceiptFixture }>({
  empty: async ({ task: _task }, use) =>
    withReceiptFixture(false, (database, options) => use({ database, options })),
  populated: async ({ task: _task }, use) =>
    withReceiptFixture(true, (database, options) => use({ database, options })),
});
function openTestReader(options: ReceiptOptions) {
  const opened = openReader(options);
  assert(opened.found && !isPostgresSqlConnection(opened.database.db), "Expected SQLite reader");
  return {
    database: opened.database,
    db: opened.database.db,
    [Symbol.dispose]: () => opened.database.close(),
  };
}
function replaceFile(pathname: string) {
  const replacement = `${pathname}.replacement`;
  fs.copyFileSync(pathname, replacement);
  fs.renameSync(replacement, pathname);
}
function activeObservers(pathname: string) {
  return observedValidationDirectories.filter(
    (observer) => observer.active && observer.directory === path.dirname(pathname),
  );
}
function canonicalReady(database: Parameters<Parameters<typeof writeTransaction>[0]>[0]) {
  return database.db.prepare("SELECT canonical_ready FROM session_key_contract").get()
    ?.canonical_ready;
}
function expectSharedSchema(database: ReceiptDatabase, reader: ReturnType<typeof openTestReader>) {
  expect(hasReadSchema(reader.database)).toBe(true);
  expect(adoptSchema(database, true, true)).toBe(true);
}
function expectFlag(cell: SharedArrayBuffer, value: number) {
  expect(Atomics.load(new Int32Array(cell), 0)).toBe(value);
}
function revokeCell(cell: SharedArrayBuffer) {
  Atomics.store(new Int32Array(cell), 0, 0);
}
function liveCell() {
  const cell = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(cell), 0, 1);
  return cell;
}
// mock-isolation: Drive identity invalidation deterministically without native watcher timing.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory(directory: string, notify: (filename?: string, event?: string) => void) {
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
  it.for(["ordinary close", "fixture retirement"] as const)(
    "handles a removed fixture's queued observation after %s",
    async (cleanup, { empty: { database } }) => {
      const captured = captureReadValidation(database)!;
      const successor = independentWorkerReceipt(database);
      const root = path.dirname(database.path);
      const observer = observedValidationDirectories.findLast(
        (candidate) => candidate.active && candidate.directory === root,
      );
      expect(observer).toBeDefined();

      await closeDatabases(root);
      expect(observer!.active).toBe(true);
      expectFlag(captured.validation.valid, 1);
      if (cleanup === "fixture retirement") {
        retireFixture(root);
        expect(observer!.active).toBe(false);
        expect(getTransfer(database)).toBeUndefined();
      }
      fs.rmSync(root, { recursive: true, force: true });

      // Model a worker publishing a new receipt after dev:ino/birthtime reuse,
      // without depending on the host filesystem's inode allocation policy.
      const target = {
        agentId: database.agentId,
        path: path.join(path.dirname(root), "successor", path.basename(database.path)),
      };
      const publish = captureTransfer(target);
      expect(publish(successor.identity, successor)).toBe(true);

      // Deliver even after close: a queued callback must not find retired path trust.
      observer!.notify(path.basename(database.path));
      expectFlag(successor.valid, cleanup === "fixture retirement" ? 1 : 0);
    },
  );

  it.for(["observation", "reader admission"] as const)(
    "retains read validation across native close and detects replacement through %s",
    (invalidation, { empty: { database } }) => {
      const captured = captureReadValidation(database);
      expect(captured?.canonicalPath).toBe(database.path);
      captured!.assertCurrent();
      closePath(database.path);
      expect(activeObservers(database.path)).not.toHaveLength(0);
      if (invalidation === "observation") {
        const stat = vi.spyOn(fs, "statSync");
        syncBuiltinESMExports();
        try {
          for (const observer of activeObservers(database.path)) {
            observer.notify(path.basename(database.path), "change");
          }
          expect(stat).not.toHaveBeenCalled();
        } finally {
          stat.mockRestore();
          syncBuiltinESMExports();
        }
      }
      replaceFile(database.path);
      expectFlag(captured!.validation.valid, 1);
      expect(captureReadValidation(database)?.validation.receiptId).toBe(
        captured?.validation.receiptId,
      );
      if (invalidation === "reader admission") {
        expect(captureReadValidation(database, "admission")).toBeUndefined();
      } else {
        for (const observer of activeObservers(database.path)) {
          observer.notify(path.basename(database.path), "rename");
        }
      }
      expect(() => captured!.assertCurrent()).toThrow(
        "Session reader validation is no longer current",
      );
      expectFlag(captured!.validation.valid, 0);
      expect(activeObservers(database.path)).toHaveLength(0);
    },
  );

  it("rejects a replaced file at receiver and queued write admission before observation", async ({
    empty: { database, options },
  }) => {
    const captured = captureReadValidation(database)!;
    closePath(database.path);
    const entered = createDeferred();
    const resume = createDeferred();
    const first = admitWrite(options, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    let effect = false;
    const queued = admitWrite(options, () => {
      effect = true;
    });
    void queued.catch(() => undefined);
    try {
      replaceFile(database.path);
      {
        using opened = openTestReader(options);
        expect(adoptValidation(opened.database, captured.validation)).toBe(false);
      }
      resume.resolve();
      await first;
      await expect(queued).rejects.toThrow("Agent database target changed before write admission");
      expect(effect).toBe(false);
    } finally {
      resume.resolve();
      await Promise.allSettled([first, queued]);
    }
  });
  it("shares republished schema proof with restart readers through a directory symlink", ({
    populated: { database },
  }) => {
    const aliasDir = path.join(path.dirname(database.path), "reader-alias");
    fs.symlinkSync(path.dirname(database.path), aliasDir, "junction");
    const alias = {
      agentId: database.agentId,
      path: path.join(aliasDir, path.basename(database.path)),
    };
    const reader = captureReadValidation(alias);
    expect(reader).toBeDefined();
    const receipt = getValidation(database)!;
    const delayed = structuredClone(receipt);
    const valid = receipt.schema!.valid;
    const publish = capturePublication(alias);
    publishSchema(database);
    expect(receipt.schema!.valid).toBe(valid);
    publish(delayed.identity, delayed);
    expect(() => reader!.assertCurrent()).not.toThrow();
    expect(getTransfer(alias)).toBe(receipt);
    invalidateValidation(database.path);
    expect(() => reader!.assertCurrent()).toThrow("Session reader validation is no longer current");
  });

  it.for(["refreshed", "replacement"] as const)(
    "repairs missing schema and shares %s proof without losing sessions",
    (receipt, { populated: { database, options } }) => {
      using reader = openTestReader(options);
      runSqliteReadOperationSync(database.db, () => expect(adoptSchema(database)).toBe(true));
      database.db.exec("BEGIN");
      try {
        expect(adoptSchema(database)).toBe(false);
      } finally {
        database.db.exec("COMMIT");
      }
      const original = getValidation(database)!.schema!;
      publishSchema(database);
      const foreign = new DatabaseSync(database.path);
      try {
        database.db.exec(
          "DROP TABLE session_reactions; CREATE TABLE late_reader_fixture(value TEXT)",
        );
        expect(adoptSchema(database)).toBe(false);
        refreshSchema(database, () => {});
        if (receipt === "replacement") {
          invalidateValidation(database.path);
          setValidation(database);
        }
        expectFlag(original.valid, 0);
        expect(adoptSchema(database, true, true)).toBe(true);
        expectSharedSchema(database, reader);
        expect(getValidation(database)?.schema?.facts?.tables.has("late_reader_fixture")).toBe(
          true,
        );
        expectRows(reader.db, "SELECT message_id FROM session_reactions", []);
        expectRow(
          reader.db,
          "SELECT current_session_id, entry_json, updated_at FROM session_nodes WHERE session_key = ?",
          {
            current_session_id: "existing",
            entry_json: '{"sessionId":"existing","updatedAt":1}',
            updated_at: 1,
          },
          "agent:main:existing",
        );
        runSqliteReadOperationSync(reader.db, () =>
          expect(adoptSchema(reader.database)).toBe(true),
        );

        // TEMP changes preserve MAIN admission; durable DDL still revokes it.
        reader.database.db.exec("CREATE TEMP TABLE local_fixture(value TEXT)");
        expect(adoptSchema(database)).toBe(true);
        database.db.exec("CREATE TABLE main.local_fixture(value TEXT)");
        expect(adoptSchema(database)).toBe(false);
        refreshSchema(database, () => {});
        expectSharedSchema(database, reader);

        foreign.exec("CREATE TABLE later_foreign_fixture(value TEXT)");
        expectSharedSchema(database, reader);

        foreign.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
        expect(adoptSchema(database)).toBe(true);
        expectSharedSchema(database, reader);
        invalidateSchema(database);
        expect(adoptSchema(database)).toBe(false);
      } finally {
        foreign.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
        foreign.close();
        reader.database.close();
      }
    },
  );

  it.for(["durable receipt", "empty view"] as const)(
    "does not certify an uncommitted %s",
    (proof, { populated: { database, options } }) => {
      expect(() =>
        writeTransaction((current) => {
          if (proof === "durable receipt") {
            recordCanonical(current);
            clearValidation(current.path);
          } else {
            current.db.exec("DELETE FROM session_nodes");
            setValidation(current);
          }
          expect(hasCanonical(current)).toBe(false);
          throw new Error("rollback proof");
        }, options),
      ).toThrow("rollback proof");
      expect(hasCanonical(database)).toBe(false);
      if (proof === "durable receipt") {
        expectRow(database.db, "SELECT canonical_ready FROM session_key_contract", {
          canonical_ready: null,
        });
      } else {
        expect(
          database.db.prepare("SELECT current_session_id FROM session_nodes").get()
            ?.current_session_id,
        ).toBe("existing");
      }
    },
  );

  it.for(["exact", "sibling-family"] as const)(
    "releases closed reader metadata by %s without revoking parent proof or unselected aliases",
    (selection, { empty: { database } }) => {
      const receipt = getValidation(database)!;
      const source = path.parse(database.path);
      const family = path.join(source.dir, `${source.name}.secondary${source.ext}`);
      const sibling = path.join(source.dir, `${source.name}-other${source.ext}`);
      const alias = path.join(source.dir, `alias${source.ext}`);
      const target = (pathname: string) => ({ agentId: database.agentId, path: pathname });
      // These admitted locators share one physical receipt, as a worker's aliases can.
      for (const pathname of [family, sibling, alias]) {
        const adopt = captureTransfer(target(pathname));
        expect(adopt(receipt.identity, receipt)).toBe(true);
      }
      closePath(database.path);
      const blockedDirectory = path.join(source.dir, "not-a-directory");
      fs.writeFileSync(blockedDirectory, "synthetic non-directory");
      const candidates = [
        { path: path.join(blockedDirectory, "unreadable.sqlite") },
        { path: database.path, ...(selection === "sibling-family" ? { scope: selection } : {}) },
      ];

      releaseReadValidation(candidates, [database.path]);
      expect(getTransfer(database)?.valid).toBe(receipt.valid);
      releaseReadValidation(candidates);

      expect(getTransfer(database)).toBeUndefined();
      if (selection === "sibling-family") {
        expect(getTransfer(target(family))).toBeUndefined();
      } else {
        expect(getTransfer(target(family))?.valid).toBe(receipt.valid);
      }
      for (const pathname of [sibling, alias]) {
        expect(getTransfer(target(pathname))?.valid).toBe(receipt.valid);
      }
      expectFlag(receipt.valid, 1);
      expectFlag(receipt.canonicalReady, 1);

      // A retired reader's path tombstone must not clear a later owner's ready receipt.
      invalidateValidation(database.path);
      releaseReadValidation(candidates);
      const adopt = captureTransfer(database);
      expect(adopt(receipt.identity, receipt)).toBe(true);
      expectFlag(receipt.canonicalReady, 1);
    },
  );

  describe("native integrity proof handoff", () => {
    it("distinguishes raced publication from malformed receipts even after revocation", ({
      empty: { database },
    }) => {
      for (const race of ["capture", "captured proof", "received proof", "schema"] as const) {
        setValidation(database);
        const original = getValidation(database)!;
        const received = independentWorkerReceipt(database);
        const publish = capturePublication(database);
        const adopt = captureTransfer(database);
        if (race === "capture") {
          invalidateValidation(database.path);
        } else {
          const cell =
            race === "captured proof"
              ? structuredClone(original).valid
              : race === "received proof"
                ? received.valid
                : received.schema!.valid;
          revokeCell(cell);
        }
        expect(() => publish(received.identity, received), race).toThrow(AdmissionChangedError);
        if (race !== "schema") {
          expect(adopt(received.identity, received)).toBe(false);
        }
        if (race === "captured proof") {
          expectFlag(received.valid, 1);
          expect(getTransfer(database)).toBeUndefined();
        }
        if (race === "schema") {
          assert(original.schema);
          expectFlag(original.schema.valid, 0);
          expect(() => adoptSchema(database, true, true)).toThrow(
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
          expect(() => publish(received.identity, malformed), race).toThrow(AdmissionInvalidError);
        }
      }
    });

    it.for([
      { cache: "canonical", transition: "promotion" },
      { cache: "empty", transition: "promotion" },
      { cache: "empty", transition: "replacement" },
      { cache: "canonical", transition: "invalidation" },
      { cache: "canonical", transition: "registration" },
    ] as const)(
      "preserves publication custody across $cache admission $transition",
      ({ cache, transition }, { populated: { database, options } }) => {
        writeTransaction(recordCanonical, options);
        const received = independentWorkerReceipt(database);
        closePath(database.path);
        clearValidation(database.path);
        revokeSqliteDatabaseAdmissionsForPath(database.path);
        using reader = openTestReader(options);
        assert(received.schema, "Expected independently admitted receipt");
        // Native fixture supplies the cold read-admission step performed by the worker.
        loadCanonical(reader.database);
        expect(hasCanonical(reader.database)).toBe(true);
        if (cache === "empty") {
          clearValidation(database.path);
        }
        expect(getTransfer(database)).toBeUndefined();
        const publish = capturePublication(database);
        if (transition === "invalidation") {
          invalidateValidation(database.path);
        } else if (transition === "registration") {
          registerDatabase({ ...options, path: database.path });
        } else if (transition === "replacement") {
          reader.database.close();
          replaceFile(database.path);
        }

        const reopened = openDatabase(options);
        const promoted = getTransfer(reopened);
        assert(promoted?.schema, "Expected the full opener to publish schema admission");
        const borrowed = structuredClone(promoted.schema);
        if (transition === "replacement") {
          expect(promoted.identity).not.toBe(received.identity);
        }
        expectFlag(received.valid, 1);
        expectFlag(received.schema.valid, 1);
        if (transition === "promotion") {
          expect(() => publish(received.identity, received)).not.toThrow();
        } else {
          expect(() => publish(received.identity, received)).toThrow(AdmissionChangedError);
        }
        expectFlag(promoted.valid, 1);
        expect(adoptSchema(reopened, true, true)).toBe(true);
        invalidateSchema(reopened);
        expectFlag(borrowed.valid, 0);
      },
    );

    it.for(["required", "optional"] as const)(
      "accepts fresh %s readmission captured after schema revocation",
      (mode, { empty: { database } }) => {
        const received = independentWorkerReceipt(database);
        assert(received.schema, "Expected independently checked schema facts");
        received.schema = { ...received.schema, valid: liveCell() };
        invalidateSchema(database);
        const publish =
          mode === "required" ? capturePublication(database) : captureTransfer(database);
        expect(() => publish(received.identity, received)).not.toThrow();
        expect(adoptSchema(database, true, true)).toBe(true);
      },
    );

    it.for(["revoked", "absent"] as const)(
      "retires borrowed schema when a native integrity receipt reports it %s",
      (schemaState, { empty: { database } }) => {
        const receipt = getValidation(database);
        assert(receipt?.schema, "Expected the fixture's admitted schema receipt");
        const borrowed = structuredClone(receipt.schema);
        const received = {
          ...independentWorkerReceipt(database),
          schema:
            schemaState === "revoked"
              ? { ...receipt.schema, valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) }
              : undefined,
        };
        const publish = captureTransfer(database);
        expect(publish(received.identity, received)).toBe(true);
        expectFlag(borrowed.valid, 0);
        expect(adoptSchema(database)).toBe(false);
      },
    );

    it.for(["current", "revoked"] as const)(
      "preserves a %s native handoff while a reader publishes durable canonical proof",
      (state, { populated: { database, options } }) => {
        writeTransaction(recordCanonical, options);
        const received = independentWorkerReceipt(database);
        clearValidation(database.path);
        const adopt = captureTransfer(database);

        expect(hasCanonical(database)).toBe(true);
        expect(getTransfer(database)).toBeUndefined();
        if (state === "revoked") {
          invalidateValidation(database.path);
        }

        expect(adopt(received.identity, received)).toBe(state === "current");
        expect(getTransfer(database)?.valid).toBe(state === "current" ? received.valid : undefined);
      },
    );

    it("does not restore delayed proof after path, repeated, cache, or agent revocation", ({
      empty: { database },
    }) => {
      const received = independentWorkerReceipt(database);
      clearValidation(database.path);

      for (const revoke of [invalidateValidation, invalidateValidation, clearValidation]) {
        const beforeRevocation = captureTransfer(database);
        revoke(database.path);
        expect(beforeRevocation(received.identity, received)).toBe(false);
      }

      // A path can be revoked before its first native opener associates an agent.
      invalidateValidation(database.path);
      const beforeAgentInvalidation = captureTransfer(database);
      invalidateAgent(database.agentId, []);
      expect(beforeAgentInvalidation(received.identity, received)).toBe(false);
      expect(getTransfer(database)).toBeUndefined();
      expectFlag(received.valid, 1);

      const afterInvalidation = captureTransfer(database);
      expect(afterInvalidation(received.identity, received)).toBe(true);
      expect(getTransfer(database)?.valid).toBe(received.valid);
      expect(hasCanonical(database)).toBe(false);

      invalidateValidation(database.path);
      const successor = { path: database.path, agentId: "successor" };
      const beforeOwnerRevocation = captureTransfer(successor);
      invalidateAgent(successor.agentId, []);
      const successorReceipt = {
        ...received,
        agentId: successor.agentId,
        identity: "successor-file",
        valid: liveCell(),
      };
      expect(beforeOwnerRevocation(successorReceipt.identity, successorReceipt)).toBe(false);
    });

    it.for(["superseded", "acknowledged"] as const)(
      "replaces revoked proof without leaking a live %s alias receipt",
      (aliasState, { empty: { database } }) => {
        const original = getValidation(database)!;
        const replacement = independentWorkerReceipt(database);
        const aliasReceipt =
          aliasState === "superseded"
            ? independentWorkerReceipt(database)
            : structuredClone(replacement);
        const alias = {
          agentId: database.agentId,
          path: path.join(path.dirname(database.path), "alias.sqlite"),
        };
        const acknowledgeAlias = capturePublication(alias);
        acknowledgeAlias(aliasReceipt.identity, aliasReceipt);
        // Worker lease cleanup revokes its transferred proof, not an independent alias.
        revokeCell(structuredClone(original).valid);
        const publish = capturePublication(database);

        publish(replacement.identity, structuredClone(replacement));

        expectFlag(aliasReceipt.valid, aliasState === "superseded" ? 0 : 1);
        expectFlag(replacement.valid, 1);
        for (const target of [database, alias]) {
          expect(getTransfer(target)).toMatchObject({
            agentId: database.agentId,
            identity: replacement.identity,
          });
        }

        invalidateValidation(alias.path);

        expectFlag(replacement.valid, 0);
        expect(getTransfer(database)).toBeUndefined();
        expect(getTransfer(alias)).toBeUndefined();
      },
    );

    it("rejects malformed receipt identities on an acknowledged alias", ({
      empty: { database },
    }) => {
      const receipt = getValidation(database)!;
      const publish = captureAliasPublication(database);
      for (const receiptId of [undefined, "", 1]) {
        expect(() => publish(receipt.identity, { ...receipt, receiptId })).toThrow(
          AdmissionInvalidError,
        );
      }
      expectFlag(receipt.valid, 1);
      expect(() => publish(receipt.identity, receipt)).not.toThrow();
    });

    it("accepts only valid native receipts without a host handle and shares revocation", ({
      empty: { database },
    }) => {
      const received = independentWorkerReceipt(database);
      closePath(database.path);
      clearValidation(database.path);
      const adopt = captureTransfer(database);
      for (const invalid of [
        { ...received, agentId: "another-agent" },
        { ...received, identity: "another-file" },
        { ...received, valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) },
      ]) {
        expect(adopt(received.identity, invalid)).toBe(false);
        expect(getTransfer(database)).toBeUndefined();
      }
      expect(adopt(received.identity, received)).toBe(true);
      expect(getTransfer(database)?.valid).toBe(received.valid);
      invalidateValidation(database.path);
      expectFlag(received.valid, 0);
      expect(getTransfer(database)).toBeUndefined();
    });
  });

  it.for([
    { cache: "warm", admission: "set" },
    { cache: "cold", admission: "adopt" },
  ] as const)(
    "does not revive revoked canonical proof on $cache integrity admission by $admission",
    ({ cache, admission }, { populated: { database, options } }) => {
      writeTransaction(recordCanonical, options);
      expect(markCanonical(database)).toBe(true);
      const receipt = getValidation(database);
      assert(receipt, "Expected physical validation receipt");
      const transferred = independentWorkerReceipt(database);
      if (cache === "cold") {
        clearValidation(database.path);
      }
      invalidateValidation(database.path);
      if (admission === "adopt") {
        expect(adoptValidation(database, transferred)).toBe(true);
        expect(getValidation(database)).toBe(transferred);
      } else {
        setValidation(database);
        expect(getValidation(database)).toBeDefined();
      }
      expect(hasCanonical(database)).toBe(false);
      expect(markCanonical(database)).toBe(true);
      expect(hasCanonical(database)).toBe(true);
      if (admission === "adopt") {
        expectFlag(transferred.canonicalReady, 1);
      }
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
          setValidation(database);
        } else if (state === "durable handoff") {
          writeTransaction(recordCanonical, options);
          clearValidation(database.path);
          captureTransfer(database);
        }
        expect(hasCanonical(database)).toBe(state === "empty" || state === "durable handoff");
        if (state === "durable handoff") {
          expect(getTransfer(database)).toBeUndefined();
          invalidateCanonical(database);
          expect(getValidation(database)).toBeUndefined();
          expect(getTransfer(database)).toBeUndefined();
        }
      });
    },
  );

  it.for(["thin", "transferred"] as const)(
    "shares proof with %s readers but never raw readers",
    (mode, { populated: { database, options } }) => {
      using raw = new DatabaseSync(database.path, { readOnly: true });
      const rawTarget = { agentId: "main", db: raw };
      expect([hasCanonical(rawTarget), markCanonical(rawTarget)]).toEqual([false, false]);
      {
        using opened = openTestReader(options);
        const receipt = getValidation(database);
        assert(receipt, "Expected physical validation receipt");
        const transferred = structuredClone(receipt);
        if (mode === "transferred") {
          expect(adoptValidation(opened.database, transferred)).toBe(true);
        }
        const target =
          mode === "thin" ? { agentId: "main", db: opened.database.db } : opened.database;
        expect(markCanonical(target)).toBe(true);
        expect(hasCanonical(database)).toBe(true);
        expect(hasCanonical({ agentId: "other", db: opened.database.db })).toBe(false);
        expectFlag(transferred.canonicalReady, 1);
        if (mode === "transferred") {
          invalidateValidation(database.path);
          expect(adoptValidation(opened.database, transferred)).toBe(false);
          expect(hasCanonical(opened.database)).toBe(false);
        }
      }
      expect(hasCanonical(database)).toBe(mode === "thin");
      expect(hasCanonical(rawTarget)).toBe(false);
    },
  );

  it.for(["commit", "rollback"] as const)(
    "revokes canonical receipts for offline repair while retaining integrity (%s)",
    (outcome, { populated: { database, options } }) => {
      writeTransaction(recordCanonical, options);
      expect(markCanonical(database)).toBe(true);
      const physical = getValidation(database);
      const mutate = () =>
        writeTransaction((current) => {
          invalidateCanonical(current);
          expect(hasCanonical(current)).toBe(false);
          expect(canonicalReady(current)).toBeNull();
          if (outcome === "rollback") {
            throw new Error("undo repair");
          }
        }, options);
      if (outcome === "rollback") {
        expect(mutate).toThrow("undo repair");
      } else {
        mutate();
      }
      expect(hasCanonical(database)).toBe(false);
      expect(getValidation(database)).toBe(physical);
      expectFlag(physical!.valid, 1);
      expect(canonicalReady(database) === null).toBe(outcome === "commit");
    },
  );

  it.for(["nested commit", "outer rollback", "savepoint rollback", "manual", "revoked"] as const)(
    "publishes transaction proof only with a valid owned commit (%s)",
    (outcome, { populated: { database, options } }) => {
      const publish = () =>
        writeTransaction((current) => {
          expect(markCanonical(current)).toBe(true);
          if (outcome === "revoked") {
            invalidateValidation(current.path);
            setValidation(current);
          } else if (outcome === "nested commit") {
            expect(hasCanonical(current)).toBe(false);
          } else {
            throw new Error("rollback proof");
          }
        }, options);
      if (outcome === "manual") {
        database.db.exec("BEGIN IMMEDIATE");
        expect(markCanonical(database)).toBe(false);
        database.db.exec("COMMIT");
      } else if (outcome === "outer rollback") {
        expect(publish).toThrow("rollback proof");
      } else if (outcome === "revoked") {
        publish();
      } else {
        writeTransaction(() => {
          if (outcome === "savepoint rollback") {
            expect(publish).toThrow("rollback proof");
          } else {
            publish();
            expect(hasCanonical(database)).toBe(false);
          }
        }, options);
      }
      expect(hasCanonical(database)).toBe(outcome === "nested commit");
    },
  );

  it.for(["native close", "native dispose", "owner close"] as const)(
    "retains proof across %s and reopen",
    (action, { populated: { database, options } }) => {
      expect(markCanonical(database)).toBe(true);
      const receipt = getValidation(database);
      if (action === "native close") {
        database.db.close();
      } else if (action === "native dispose") {
        database.db[Symbol.dispose]();
      } else {
        closePath(database.path);
      }
      const reopened = openDatabase(options);
      expect(getValidation(reopened) === receipt).toBe(true);
      expect(hasCanonical(reopened)).toBe(true);
    },
  );

  it
    .runIf(typeof DatabaseSync.prototype.deserialize === "function")
    .for(["integrity proof", "canonical enrichment"] as const)(
    "revokes delayed %s on a failed native replacement attempt",
    (proof, { populated: { database, options } }) => {
      expect(markCanonical(database)).toBe(true);
      const received = independentWorkerReceipt(database);
      if (proof === "canonical enrichment") {
        writeTransaction(recordCanonical, options);
        clearValidation(database.path);
      }
      const adopt = captureTransfer(database);
      expect(hasCanonical(database)).toBe(true);
      const serialized = database.db.serialize();
      database.db.exec("BEGIN IMMEDIATE");
      try {
        database.db.prepare("SELECT session_key FROM session_nodes").get();
        expect(() => database.db.deserialize(serialized)).toThrow();
        expect(getValidation(database)).toBeUndefined();
        expect(hasCanonical(database)).toBe(false);
        expect(adopt(received.identity, received)).toBe(false);
      } finally {
        database.db.exec("ROLLBACK");
      }
      const fresh = captureTransfer(database);
      expect(fresh(received.identity, received)).toBe(true);
    },
  );
});
