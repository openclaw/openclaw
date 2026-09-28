import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  invalidateRegisteredAgentDatabasesMemo,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as entryReads from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  loadSessionEntryReadOnlyInScope,
  loadSessionEntryReadOnlyResultInScope,
} from "./session-accessor.sqlite-entry.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { readSessionStoreTargetResult } from "./session-store-target-inventory.js";
import { historyLane } from "./session-transcript-worker-resources.js";

it.each([false, true])(
  "returns unreadable-store data only after its connection closes (close failure: %s)",
  async (failClose) => {
    await withOpenClawTestState({ label: "readonly-entry-open-failure" }, async ({ env, path }) => {
      const storePath = path("unreadable.sqlite");
      writeFileSync(storePath, "Not a SQLite database");
      const closeError = Object.assign(new Error("native read close failed"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 26,
      });
      const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
      let reader: DatabaseSync | undefined;
      let restoreClose: (() => void) | undefined;
      const open = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((location, options) => {
          const database = nativeOpen(location, options);
          if (location === storePath) {
            reader = database;
            if (failClose) {
              const close = vi.spyOn(database, "close").mockImplementation(() => {
                throw closeError;
              });
              restoreClose = () => close.mockRestore();
            }
          }
          return database;
        });
      const read = () =>
        loadSessionEntryReadOnlyResultInScope({
          agentId: "main",
          databaseAgentId: "main",
          storePath,
          sessionKey: "agent:main:unreadable",
          env,
        });
      try {
        if (failClose) {
          expect(read).toThrow(closeError);
        } else {
          expect(read()).toMatchObject({
            ok: false,
            error: { code: "ERR_SQLITE_ERROR", errcode: 26 },
          });
          expect(reader?.isOpen).toBe(false);
        }
      } finally {
        restoreClose?.();
        open.mockRestore();
        if (reader?.isOpen) {
          reader.close();
        }
      }
    });
  },
);

it.each([false, true])(
  "keeps schema error classification with a disposable reader: %s",
  async (disposable) => {
    await withOpenClawTestState({ label: "readonly-entry-schema-error" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:schema-error";
      writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
      database.db.exec("DROP TABLE board_widgets");
      if (disposable) {
        await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
      }
      const failure = Object.assign(new Error("native selected-row query failed"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 1,
      });
      let reader: typeof database.db | undefined;
      const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation((source) => {
        reader = source.db;
        throw failure;
      });
      try {
        const result = loadSessionEntryReadOnlyResultInScope({
          agentId: "main",
          databaseAgentId: "main",
          storePath: database.path,
          sessionKey,
          env,
        });
        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("Expected a selected-row failure");
        }
        expect(result.error).toBeInstanceOf(SessionMetadataUnavailableError);
        expect(result.error).toMatchObject({
          reason: "table-missing",
          missingTables: ["board_widgets"],
        });
        expect(reader?.isOpen).toBe(!disposable);
      } finally {
        read.mockRestore();
      }
    });
  },
);

it("returns row data failures only after the native snapshot rolled back", async () => {
  await withOpenClawTestState({ label: "readonly-entry-error" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:entry-error";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const scope = {
      agentId: "main",
      databaseAgentId: "main",
      storePath: database.path,
      sessionKey,
      env,
    };
    loadSessionEntryReadOnlyInScope(scope);
    const continuation = captureCanonicalSessionReaderContinuation(database);
    if (!continuation) {
      throw new Error("Expected the committed reader admission");
    }
    const failure = new Error("selected row could not be decoded");
    const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation(() => {
      throw failure;
    });
    try {
      const result = loadSessionEntryReadOnlyResultInScope(scope, continuation.receipt);
      expect(result).toEqual({ ok: false, error: failure });
      expect(database.db.isTransaction).toBe(false);
      expect(database.db.isOpen).toBe(true);
    } finally {
      read.mockRestore();
      continuation.release();
    }
  });
});

it("does not downgrade a failed rollback to an ordinary row failure", async () => {
  await withOpenClawTestState({ label: "readonly-entry-rollback" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:rollback-error";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const scope = {
      agentId: "main",
      databaseAgentId: "main",
      storePath: database.path,
      sessionKey,
      env,
    };
    loadSessionEntryReadOnlyInScope(scope);
    const continuation = captureCanonicalSessionReaderContinuation(database);
    if (!continuation) {
      throw new Error("Expected the committed reader admission");
    }
    const exec = database.db.exec.bind(database.db);
    const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation(() => {
      throw new Error("selected row failed");
    });
    const rollback = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") {
        throw new Error("native rollback failed");
      }
      return exec(sql);
    });
    try {
      expect(() => loadSessionEntryReadOnlyResultInScope(scope, continuation.receipt)).toThrow();
      expect(database.db.isOpen).toBe(false);
    } finally {
      rollback.mockRestore();
      read.mockRestore();
      continuation.release();
    }
  });
});

it("keeps source refusal outside the ordinary row-error result", async () => {
  await withOpenClawTestState({ label: "readonly-entry-source" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:source-error";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const refusal = Object.assign(new Error("retained source changed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 26,
    });
    expect(() =>
      loadSessionEntryReadOnlyResultInScope(
        {
          agentId: "main",
          databaseAgentId: "main",
          storePath: database.path,
          sessionKey,
          env,
        },
        undefined,
        () => {
          throw refusal;
        },
      ),
    ).toThrow(refusal);
  });
});

it("propagates raw worker failure without calling the optional-data consumer", async () => {
  await withOpenClawTestState({ label: "readonly-entry-transport" }, async ({ env, path }) => {
    const failure = new Error("worker could not start");
    const run = vi.spyOn(historyLane.pool, "run").mockRejectedValueOnce(failure);
    const consume = vi.fn(async () => undefined);
    try {
      await expect(
        withSessionEntryReadOnlyInWorker(
          {
            agentId: "main",
            sessionKey: "agent:main:missing",
            storePath: path("missing.sqlite"),
            env,
          },
          () => {},
          consume,
        ),
      ).rejects.toBe(failure);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
});

it("rejects registry revocation during the retained asynchronous consumer", async () => {
  await withOpenClawTestState({ label: "readonly-entry-retained" }, async ({ env, path }) => {
    const storePath = path("shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
    const sessionKey = "agent:main:retained";
    writeSessionEntry(database, sessionKey, {
      sessionId: "retained-session",
      updatedAt: 1,
      skillsSnapshot: { prompt: "Full stored prompt", skills: [] },
    });
    let consumed = false;
    await expect(
      withSessionEntryReadOnlyInWorker(
        {
          sessionKey,
          storePath,
          env,
          hydrateSkillPromptRefs: false,
        },
        () => {},
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          expect(read.value?.skillsSnapshot?.prompt).toBe("Full stored prompt");
          consumed = true;
          await Promise.resolve();
          invalidateRegisteredAgentDatabasesMemo({ env });
          return read.value;
        },
      ),
    ).rejects.toThrow("registry changed");
    expect(consumed).toBe(true);
  });
});

it("retains the registry witness even when the first read rejects before returning a snapshot", async () => {
  await withOpenClawTestState({ label: "readonly-registry-witness" }, async ({ env }) => {
    const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
    const pending = prepared.read();
    invalidateRegisteredAgentDatabasesMemo({ env });
    await expect(pending).rejects.toThrow("registry changed");
    expect(() => prepared.assertCurrent()).toThrow("registry changed");
  });
});

it("checks the captured registry after logical data cleanup", async () => {
  await withOpenClawTestState({ label: "readonly-entry-cleanup" }, async ({ env, path }) => {
    const storePath = path("shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
    const sessionKey = "agent:main:cron:job:run:cleanup";
    writeSessionEntry(database, sessionKey, { sessionId: "cleanup-session", updatedAt: 1 });
    const pool = historyLane.pool;
    const rotate = pool.rotate.bind(pool);
    const closeResources = pool.closeResources.bind(pool);
    let cleanupCalled = false;
    const cleanup = process.versions.bun
      ? vi.spyOn(pool, "rotate").mockImplementation(async () => {
          await rotate();
          cleanupCalled = true;
          invalidateRegisteredAgentDatabasesMemo({ env });
        })
      : vi.spyOn(pool, "closeResources").mockImplementation(async (key) => {
          await closeResources(key);
          cleanupCalled = true;
          invalidateRegisteredAgentDatabasesMemo({ env });
        });
    let consumed = false;
    try {
      const pending = withSessionEntryReadOnlyInWorker(
        { sessionKey, storePath, env },
        () => {},
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          consumed = true;
          return read.value;
        },
      );
      await expect(pending).rejects.toThrow("registry changed");
      expect(cleanupCalled).toBe(true);
      expect(consumed).toBe(true);
    } finally {
      cleanup.mockRestore();
    }
  });
});

it("returns unavailable registry facts as locator data without catching candidate escape", async () => {
  await withOpenClawTestState({ label: "readonly-target-result" }, async ({ env, path }) => {
    const request = {
      agentId: "main",
      storePath: path("shared.sqlite"),
      env,
      candidates: [],
      registeredDatabases: { status: "unavailable" as const },
    };
    expect(readSessionStoreTargetResult(request)).toMatchObject({ ok: false });
    expect(() => readSessionStoreTargetResult({ ...request, registeredDatabases: [] })).toThrow(
      "outside captured discovery custody",
    );
  });
});

it.runIf(process.platform !== "win32").each([false, true])(
  "retains a custom store alias through its data consumer (retargeted: %s)",
  async (retarget) => {
    await withOpenClawTestState({ label: "readonly-store-alias" }, async ({ env, path }) => {
      const original = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:alias";
      writeSessionEntry(original, sessionKey, { sessionId: "original", updatedAt: 1 });
      const replacement = retarget
        ? openOpenClawAgentDatabase({ agentId: "main", path: path("replacement.sqlite"), env })
        : undefined;
      const alias = path("custom.sqlite");
      symlinkSync(original.path, alias);
      let consumed = false;
      const pending = withSessionEntryReadOnlyInWorker(
        { agentId: "main", sessionKey, storePath: path("custom.json"), env },
        () => {},
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          expect(read.value?.sessionId).toBe("original");
          consumed = true;
          await Promise.resolve();
          if (replacement) {
            unlinkSync(alias);
            symlinkSync(replacement.path, alias);
          }
          return read.value;
        },
      );
      if (retarget) {
        await expect(pending).rejects.toThrow("Session store alias changed during discovery");
      } else {
        await expect(pending).resolves.toMatchObject({ sessionId: "original" });
      }
      expect(consumed).toBe(true);
    });
  },
);
