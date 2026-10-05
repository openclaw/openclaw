import { copyFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  readMainDatabasePosixLocks,
  readSqliteArtifactBytesFromChild,
} from "../infra/sqlite-posix-locks.test-support.js";
import * as snapshotCleanup from "../infra/sqlite-readonly-location-cleanup.js";
import * as snapshotWorker from "../infra/sqlite-readonly-worker.js";
import {
  hasPersistedOpenClawAgentCanonicalValidation,
  withFreshOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
  prepareSqliteReadOnlyLocationSync,
  inspectSharedAuthPluginArtifactsReadOnly,
} from "../plugin-sdk/sqlite-runtime.js";
import { runSqliteDeferredTransactionSync } from "../plugin-sdk/sqlite-worker-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recordOpenClawAgentCanonicalValidation } from "./openclaw-agent-canonical-validation-receipt.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  isOpenClawAgentReadCallbackCurrent,
  type OpenClawAgentReadOnlyDatabase,
} from "./openclaw-agent-db-readonly-open.js";
import { assertOpenClawAgentSchemaContains } from "./openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

it.each(["current", "replacement", "closed", "cancelled"] as const)(
  "keeps the synchronous admitted copy boundary for %s original disposition",
  async (disposition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const owner = openOpenClawAgentDatabase(options);
      runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
      let escaped: OpenClawAgentReadOnlyDatabase | undefined;
      expect(
        withOpenClawAgentDatabaseReadOnly((database) => {
          escaped = database;
          expect(isOpenClawAgentReadCallbackCurrent(database)).toBe(true);
          const identity = readOpenClawAgentDatabaseIdentity(database);
          const expectedSourceIdentity = {
            key: `file:${String(identity.identity)}`,
            birthtime: identity.birthtime,
          };
          const bytes = readSqliteArtifactBytesFromChild(owner.path);
          const locks =
            process.platform === "linux" ? readMainDatabasePosixLocks(owner.path) : undefined;
          if (locks) {
            expect(locks).toHaveLength(1);
          }
          const controller = new AbortController();
          if (disposition === "closed") {
            database.db.close();
            expect(isOpenClawAgentReadCallbackCurrent(database)).toBe(false);
          } else if (disposition === "replacement") {
            const originalPath = state.path("retired-sync.sqlite");
            renameSync(owner.path, originalPath);
            copyFileSync(originalPath, owner.path);
            expect(() =>
              prepareSqliteReadOnlyLocationSync(owner.path, { expectedSourceIdentity }),
            ).toThrow(/file identity changed/u);
            renameSync(owner.path, state.path("successor-sync.sqlite"));
            renameSync(originalPath, owner.path);
            expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(true);
          } else if (disposition === "cancelled") {
            const failure = new Error("fixture sync cancellation");
            controller.abort(failure);
            expect(() =>
              prepareSqliteReadOnlyLocationSync(owner.path, {
                expectedSourceIdentity,
                signal: controller.signal,
              }),
            ).toThrow(failure);
            expect(readSqliteArtifactBytesFromChild(owner.path)).toEqual(bytes);
          } else {
            const snapshot = prepareSqliteReadOnlyLocationSync(owner.path, {
              expectedSourceIdentity,
            });
            try {
              using copy = new DatabaseSync(snapshot.location, { readOnly: true });
              expect(
                copy.prepare("SELECT canonical_ready FROM session_key_contract WHERE id=1").get(),
              ).toEqual(
                owner.db
                  .prepare("SELECT canonical_ready FROM session_key_contract WHERE id=1")
                  .get(),
              );
              expect(
                hasPersistedOpenClawAgentCanonicalValidation({ db: copy, agentId: "main" }),
              ).toBe(false);
              expect(readSqliteArtifactBytesFromChild(owner.path)).toEqual(bytes);
              if (locks) {
                expect(readMainDatabasePosixLocks(owner.path)).toEqual(locks);
              }
              expect(isOpenClawAgentReadCallbackCurrent(database)).toBe(true);
            } finally {
              expect(snapshot.cleanup()).toBe(true);
            }
          }
          return "observed";
        }, options),
      ).toEqual({ found: true, value: "observed" });
      if (!escaped) {
        throw new Error("Expected source callback");
      }
      expect(isOpenClawAgentReadCallbackCurrent(escaped)).toBe(false);
    });
  },
);

it.each(["outside", "raw", "copy", "closed", "cancelled", "replaced"] as const)(
  "refuses a %s source at the SDK artifact inspection boundary",
  async (condition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const owner = openOpenClawAgentDatabase(options);
      runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
      if (condition === "outside") {
        expect(inspectSharedAuthPluginArtifactsReadOnly(owner, { env: state.env })).toMatchObject({
          status: "refused",
          reason: "source-callback",
          cleanupConfirmed: true,
        });
        return;
      }
      if (condition === "raw") {
        using raw = new DatabaseSync(owner.path, { readOnly: true });
        expect(
          inspectSharedAuthPluginArtifactsReadOnly(
            { db: raw, agentId: "main", path: owner.path },
            { env: state.env },
          ),
        ).toMatchObject({ status: "refused", reason: "source-callback", cleanupConfirmed: true });
        return;
      }
      if (condition === "copy") {
        closeOpenClawAgentDatabaseByPath(owner.path);
        const copy = state.path("private-source-copy.sqlite");
        copyFileSync(owner.path, copy);
        expect(
          withFreshOpenClawAgentDatabaseReadOnly(
            (native) => inspectSharedAuthPluginArtifactsReadOnly(native, { env: state.env }),
            { ...options, path: copy },
          ),
        ).toMatchObject({
          found: true,
          value: { status: "refused", reason: "source-binding", cleanupConfirmed: true },
        });
        return;
      }
      expect(
        withOpenClawAgentDatabaseReadOnly((native) => {
          const controller = new AbortController();
          if (condition === "closed") {
            native.db.close();
          }
          if (condition === "cancelled") {
            controller.abort(new Error("unsafe fixture cancellation text"));
          }
          if (condition === "replaced") {
            const originalPath = state.path("removed-inspection-source.sqlite");
            renameSync(owner.path, originalPath);
            copyFileSync(originalPath, owner.path);
          }
          const value = inspectSharedAuthPluginArtifactsReadOnly(native, {
            env: state.env,
            signal: controller.signal,
          });
          expect(value).toMatchObject({ status: "refused", cleanupConfirmed: true });
          expect(JSON.stringify(value)).not.toContain("unsafe fixture cancellation text");
          return value.status;
        }, options),
      ).toEqual({ found: true, value: "refused" });
    });
  },
);

it("preserves failed pre-adoption snapshot cleanup custody in the SDK refusal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const owner = openOpenClawAgentDatabase(options);
    const remove = snapshotCleanup.removeTempDirectory;
    // The real preparation owner creates/removes staging; leaves inject its failed receipt.
    const worker = vi
      .spyOn(snapshotWorker, "runSqliteReadOnlyWorkerSync")
      .mockImplementation(() => {
        throw new Error("synthetic private preparation failure");
      });
    const cleanup = vi
      .spyOn(snapshotCleanup, "removeTempDirectory")
      .mockImplementation((...args) => {
        remove(...args);
        return false;
      });
    try {
      expect(
        withOpenClawAgentDatabaseReadOnly(
          (native) => inspectSharedAuthPluginArtifactsReadOnly(native, { env: state.env }),
          options,
        ),
      ).toEqual({
        found: true,
        value: {
          status: "refused",
          phase: "source-copy",
          reason: "unavailable",
          cleanupConfirmed: false,
        },
      });
      expect(owner.db.isOpen).toBe(true);
    } finally {
      cleanup.mockRestore();
      worker.mockRestore();
    }
  });
});

it.each(["legacy-birthtime", "missing-column"] as const)(
  "records canonical proof at the same schema version for %s receipts",
  async (legacy) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const original = openOpenClawAgentDatabase(options);
      if (legacy === "missing-column") {
        closeOpenClawAgentDatabaseByPath(original.path);
        using old = new DatabaseSync(original.path);
        old.exec("ALTER TABLE session_key_contract DROP COLUMN canonical_ready");
      }
      const database = openOpenClawAgentDatabase(options);
      const version = database.db.prepare("PRAGMA user_version").get();
      const schema = database.db.prepare("PRAGMA schema_version").get();
      if (legacy === "legacy-birthtime") {
        const file = statSync(database.path, { bigint: true });
        const birthtime = file.birthtimeNs.toString();
        database.db
          .prepare("UPDATE session_key_contract SET canonical_ready = ? WHERE id = 1")
          .run(JSON.stringify([1, "main", `${file.dev}:${file.ino}`, birthtime]));
        expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(
          process.platform !== "linux" || birthtime === "0",
        );
      } else {
        expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(false);
        expect(() =>
          runOpenClawAgentWriteTransaction((current) => {
            recordOpenClawAgentCanonicalValidation(current);
            throw new Error("rollback first receipt");
          }, options),
        ).toThrow("rollback first receipt");
        expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(schema);
        expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(false);
      }
      runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
      expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(true);
      if (legacy === "missing-column") {
        expect(
          database.db
            .prepare("PRAGMA table_info(session_key_contract)")
            .all()
            .find((column) => column.name === "canonical_ready"),
        ).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
        const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(
          /^\s*canonical_ready TEXT,\n/mu,
          "",
        );
        expect(() =>
          assertOpenClawAgentSchemaContains(database.db, database.path, previousSchema),
        ).not.toThrow();
        const completeSchema = database.db.prepare("PRAGMA schema_version").get();
        runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
        expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(completeSchema);
      } else {
        expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(schema);
      }
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual(version);
    });
  },
);

it("requires admitted physical identity and write admission for persisted canonical receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const database = openOpenClawAgentDatabase(options);
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    const raw = new DatabaseSync(database.path, { readOnly: true });
    try {
      expect(hasPersistedOpenClawAgentCanonicalValidation({ db: raw, agentId: "main" })).toBe(
        false,
      );
      expect(hasPersistedOpenClawAgentCanonicalValidation({ ...database, agentId: "other" })).toBe(
        false,
      );
      expect(() => recordOpenClawAgentCanonicalValidation(database)).toThrow("write admission");
    } finally {
      raw.close();
    }
  });
});

it("validates the compared receipt through the SDK fresh reader without writing or creating stores", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const owner = openOpenClawAgentDatabase(options);
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    const expected = owner.db.prepare("SELECT * FROM session_key_contract WHERE id = 1").get();
    const version = owner.db.prepare("PRAGMA user_version").get();
    closeOpenClawAgentDatabaseByPath(owner.path);
    const bytes = readFileSync(owner.path);
    let connection: DatabaseSync | undefined;
    expect(
      withFreshOpenClawAgentDatabaseReadOnly((database) => {
        connection = database.db;
        expect(() => database.db.exec("CREATE TABLE unexpected (value TEXT)")).toThrow(/readonly/u);
        return runSqliteDeferredTransactionSync(database.db, () => ({
          row: database.db.prepare("SELECT * FROM session_key_contract WHERE id = 1").get(),
          valid: hasPersistedOpenClawAgentCanonicalValidation(database),
          version: database.db.prepare("PRAGMA user_version").get(),
        }));
      }, options),
    ).toEqual({ found: true, value: { row: expected, valid: true, version } });
    expect(connection?.isOpen).toBe(false);
    expect(readFileSync(owner.path)).toEqual(bytes);
    const missing = state.path("uncreated", "agent.sqlite");
    const operation = vi.fn();
    expect(
      withFreshOpenClawAgentDatabaseReadOnly(operation, { ...options, path: missing }),
    ).toEqual({
      found: false,
      reason: "database-missing",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(existsSync(state.path("uncreated"))).toBe(false);
  });
});

it.each(["malformed", "unknown-revision", "wrong-agent"] as const)(
  "refuses %s receipts through the admitted SDK reader",
  async (condition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
      const persisted = owner.db
        .prepare("SELECT canonical_ready FROM session_key_contract WHERE id = 1")
        .get()?.canonical_ready;
      if (typeof persisted !== "string") {
        throw new Error("Expected writer-owned fixture receipt");
      }
      const invalid: unknown[] = JSON.parse(persisted);
      if (condition === "unknown-revision") {
        invalid[0] = 999;
      } else if (condition === "wrong-agent") {
        invalid[1] = "other";
      }
      owner.db
        .prepare("UPDATE session_key_contract SET canonical_ready = ? WHERE id = 1")
        .run(condition === "malformed" ? "invalid-json" : JSON.stringify(invalid));
      closeOpenClawAgentDatabaseByPath(owner.path);
      expect(
        withFreshOpenClawAgentDatabaseReadOnly(
          hasPersistedOpenClawAgentCanonicalValidation,
          options,
        ),
      ).toEqual({ found: true, value: false });
    });
  },
);

it("refuses copied and replaced receipt generations and closes a failed SDK callback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const owner = openOpenClawAgentDatabase(options);
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    closeOpenClawAgentDatabaseByPath(owner.path);
    const copy = state.path("copy.sqlite");
    copyFileSync(owner.path, copy);
    expect(
      withFreshOpenClawAgentDatabaseReadOnly(hasPersistedOpenClawAgentCanonicalValidation, {
        ...options,
        path: copy,
      }),
    ).toEqual({ found: true, value: false });
    let connection: DatabaseSync | undefined;
    const failure = new Error("synthetic reader failure");
    expect(() =>
      withFreshOpenClawAgentDatabaseReadOnly((database) => {
        connection = database.db;
        expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(true);
        renameSync(owner.path, state.path("retired.sqlite"));
        copyFileSync(copy, owner.path);
        expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(false);
        throw failure;
      }, options),
    ).toThrow(failure);
    expect(connection?.isOpen).toBe(false);
  });
});

it.each(["foreign-owner", "unsupported-version", "invalid-schema"] as const)(
  "refuses %s before lending the SDK reader callback",
  async (condition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const owner = openOpenClawAgentDatabase(options);
      runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
      if (condition === "foreign-owner") {
        owner.db.exec("UPDATE schema_meta SET agent_id = 'other' WHERE meta_key = 'primary'");
      } else if (condition === "unsupported-version") {
        owner.db.exec("PRAGMA user_version = 999");
      } else {
        owner.db.exec("DROP TABLE session_canonical_validation_pending");
      }
      closeOpenClawAgentDatabaseByPath(owner.path);
      const operation = vi.fn(hasPersistedOpenClawAgentCanonicalValidation);
      expect(() => withFreshOpenClawAgentDatabaseReadOnly(operation, options)).toThrow(
        condition === "foreign-owner"
          ? /belongs to agent other/u
          : condition === "unsupported-version"
            ? /newer schema/u
            : expect.objectContaining({
                name: "SessionMetadataUnavailableError",
                reason: "table-missing",
                missingTables: ["session_canonical_validation_pending"],
              }),
      );
      expect(operation).not.toHaveBeenCalled();
    });
  },
);
