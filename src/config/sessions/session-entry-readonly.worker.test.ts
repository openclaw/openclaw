import { mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { assertSessionEntryCurrentAdmission } from "./session-entry-current-admission.js";
import { captureSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import type { SessionEntryCurrentCheck } from "./session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { readSessionStoreTargetResult } from "./session-store-target-inventory.js";
import { historyLane } from "./session-transcript-worker-resources.js";

function createEntryFixture(env: NodeJS.ProcessEnv) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const sessionKey = "agent:main:readonly-entry";
  writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
  const scope = {
    agentId: "main",
    databaseAgentId: "main",
    storePath: database.path,
    sessionKey,
    env,
  };
  return { database, scope };
}

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

it.each(["schema-retained", "schema-disposable", "row", "rollback"] as const)(
  "classifies selected-row failures only after reader cleanup: %s",
  async (mode) => {
    await withOpenClawTestState({ label: "readonly-entry-error" }, async ({ env }) => {
      const { database, scope } = createEntryFixture(env);
      const schema = mode.startsWith("schema");
      const disposable = mode === "schema-disposable";
      if (schema) {
        database.db.exec("DROP TABLE board_widgets");
        if (disposable) {
          await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
        }
      } else {
        loadSessionEntryReadOnlyInScope(scope);
      }
      const continuation = schema ? undefined : captureCanonicalSessionReaderContinuation(database);
      if (!schema && !continuation) {
        throw new Error("Expected the committed reader admission");
      }
      const failure = schema
        ? Object.assign(new Error("native selected-row query failed"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 1,
          })
        : new Error("selected row could not be decoded");
      let reader: typeof database.db | undefined;
      const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation((source) => {
        reader = source.db;
        throw failure;
      });
      const exec = database.db.exec.bind(database.db);
      const rollback =
        mode === "rollback"
          ? vi.spyOn(database.db, "exec").mockImplementation((sql) => {
              if (sql === "ROLLBACK") {
                throw new Error("native rollback failed");
              }
              return exec(sql);
            })
          : undefined;
      try {
        const load = () => loadSessionEntryReadOnlyResultInScope(scope, continuation?.receipt);
        if (mode === "rollback") {
          expect(load).toThrow();
          expect(database.db.isOpen).toBe(false);
        } else if (schema) {
          const result = load();
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
        } else {
          expect(load()).toEqual({ ok: false, error: failure });
          expect(database.db.isTransaction).toBe(false);
          expect(database.db.isOpen).toBe(true);
        }
      } finally {
        rollback?.mockRestore();
        read.mockRestore();
        continuation?.release();
      }
    });
  },
);

it("keeps source refusal outside the ordinary row-error result", async () => {
  await withOpenClawTestState({ label: "readonly-entry-source" }, async ({ env }) => {
    const { scope } = createEntryFixture(env);
    const refusal = Object.assign(new Error("retained source changed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 26,
    });
    expect(() =>
      loadSessionEntryReadOnlyResultInScope(scope, undefined, () => {
        throw refusal;
      }),
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

it.each(["consumer", "cleanup"] as const)(
  "rejects registry revocation during %s",
  async (phase) => {
    await withOpenClawTestState({ label: "readonly-entry-registry" }, async ({ env, path }) => {
      const storePath = path("shared.sqlite");
      const sessionKey =
        phase === "consumer" ? "agent:main:retained" : "agent:main:cron:job:run:cleanup";
      if (phase === "consumer") {
        replaceSessionEntrySync(
          { agentId: "main", storePath, env, sessionKey },
          {
            sessionId: "retained-session",
            updatedAt: 1,
            skillsSnapshot: { prompt: "Full stored prompt", skills: [] },
          },
        );
      } else {
        const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
        writeSessionEntry(database, sessionKey, { sessionId: "cleanup-session", updatedAt: 1 });
      }
      const pool = historyLane.pool;
      const rotate = pool.rotate.bind(pool);
      const closeResources = pool.closeResources.bind(pool);
      let cleanupCalled = false;
      const invalidateAfterCleanup = () => {
        if (!cleanupCalled) {
          cleanupCalled = true;
          invalidateRegisteredAgentDatabasesMemo({ env });
        }
      };
      const rotateCleanup =
        phase === "cleanup"
          ? vi.spyOn(pool, "rotate").mockImplementation(async () => {
              await rotate();
              invalidateAfterCleanup();
            })
          : undefined;
      const resourceCleanup =
        phase === "cleanup"
          ? vi.spyOn(pool, "closeResources").mockImplementation(async (key) => {
              await closeResources(key);
              invalidateAfterCleanup();
            })
          : undefined;
      let consumed = false;
      try {
        await expect(
          withSessionEntryReadOnlyInWorker(
            {
              sessionKey,
              storePath,
              env,
              ...(phase === "consumer" ? { hydrateSkillPromptRefs: false } : {}),
            },
            () => {},
            async (read) => {
              if (!read.ok) {
                throw read.error;
              }
              consumed = true;
              if (phase === "consumer") {
                expect(read.value?.skillsSnapshot?.prompt).toBe("Full stored prompt");
                await Promise.resolve();
                invalidateRegisteredAgentDatabasesMemo({ env });
              }
              return read.value;
            },
          ),
        ).rejects.toThrow("registry changed");
        if (phase === "cleanup") {
          expect(cleanupCalled).toBe(true);
        }
        expect(consumed).toBe(true);
      } finally {
        rotateCleanup?.mockRestore();
        resourceCleanup?.mockRestore();
      }
    });
  },
);

it("retains the registry witness even when the first read rejects before returning a snapshot", async () => {
  await withOpenClawTestState({ label: "readonly-registry-witness" }, async ({ env }) => {
    const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
    const pending = prepared.read();
    invalidateRegisteredAgentDatabasesMemo({ env });
    await expect(pending).rejects.toThrow("registry changed");
    expect(() => prepared.assertCurrent()).toThrow("registry changed");
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

it.runIf(process.platform !== "win32").each([
  { retarget: true, logicalAgentId: "main" },
  { retarget: false, logicalAgentId: "ops" },
])(
  "retains logical $logicalAgentId through its alias consumer (retargeted: $retarget)",
  async ({ retarget, logicalAgentId }) => {
    await withOpenClawTestState({ label: "readonly-store-alias" }, async ({ env, path }) => {
      const original = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = `agent:${logicalAgentId}:alias`;
      writeSessionEntry(original, sessionKey, { sessionId: "original", updatedAt: 1 });
      if (logicalAgentId !== "main") {
        writeSessionEntry(original, "agent:main:alias", { sessionId: "other-agent", updatedAt: 1 });
      }
      const replacement = retarget
        ? openOpenClawAgentDatabase({ agentId: "main", path: path("replacement.sqlite"), env })
        : undefined;
      const alias = path("custom.sqlite");
      symlinkSync(original.path, alias);
      let consumed = false;
      const pending = withSessionEntryReadOnlyInWorker(
        {
          agentId: logicalAgentId,
          sessionKey,
          storePath: logicalAgentId === "main" ? path("custom.json") : alias,
          env,
        },
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          expect(read.value?.sessionId).toBe("original");
          expect(owner.scope).toMatchObject({
            agentId: logicalAgentId,
            databaseAgentId: "main",
            storePath: original.path,
          });
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

it.each(["logical", "omitted", "empty"] as const)(
  "fences the selected SQLite alias after a %s store read releases its initial owner",
  async (locator) => {
    await withOpenClawTestState({ label: "currency-selected-store-alias" }, async (state) => {
      const original = openOpenClawAgentDatabase({
        agentId: "main",
        path: state.statePath("original", "openclaw-agent.sqlite"),
        env: state.env,
      });
      const replacement = openOpenClawAgentDatabase({
        agentId: "main",
        path: state.statePath("replacement", "openclaw-agent.sqlite"),
        env: state.env,
      });
      const sessionKey = "agent:main:subagent:currency-selected-alias";
      const entry = {
        sessionId: "selected-alias-session",
        lifecycleRevision: "selected-alias-lifecycle",
        lifecycleRunId: "selected-alias-run",
        updatedAt: 1,
      };
      writeSessionEntry(original, sessionKey, entry);
      writeSessionEntry(replacement, sessionKey, entry);
      const alias = state.agentDir();
      mkdirSync(dirname(alias), { recursive: true });
      const linkType = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(dirname(original.path), alias, linkType);
      mkdirSync(state.sessionsDir(), { recursive: true });
      const logicalParent = realpathSync(state.sessionsDir());
      const selectedSqlite = join(state.agentDir(), "openclaw-agent.sqlite");
      expect(realpathSync(selectedSqlite)).toBe(realpathSync(original.path));
      const scope = {
        agentId: "main",
        sessionKey,
        env: state.env,
        ...(locator === "logical"
          ? { storePath: join(state.sessionsDir(), "sessions.json") }
          : locator === "empty"
            ? { storePath: "" }
            : {}),
      };
      const current = await withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          expect(read.value?.sessionId).toBe(entry.sessionId);
          return captureSessionEntryCurrentRead(scope, owner);
        },
      );
      if (current.kind !== "file") {
        throw new Error("Expected the selected durable alias source");
      }
      const nativeCheck: SessionEntryCurrentCheck = {
        source: current.source,
        assertCurrent: () => current.assertSourceCurrent(),
      };
      await expect(current.readCurrent()).resolves.toMatchObject({
        sessionId: entry.sessionId,
        lifecycleRunId: entry.lifecycleRunId,
      });
      rmSync(alias, { recursive: true, force: true });
      symlinkSync(dirname(replacement.path), alias, linkType);
      expect(realpathSync(state.sessionsDir())).toBe(logicalParent);
      expect(realpathSync(selectedSqlite)).toBe(realpathSync(replacement.path));
      expect(entryReads.readSessionEntryRow(original, sessionKey)?.entry.sessionId).toBe(
        entry.sessionId,
      );
      await expect(current.readCurrent()).rejects.toThrow(
        "Session currency logical source changed",
      );
      expect(() =>
        assertSessionEntryCurrentAdmission(
          {
            stage: "commit",
            facts: {
              kind: "session-entry-current",
              source: current.source,
              entry,
              domainFacts: undefined,
            },
          },
          nativeCheck,
        ),
      ).toThrow("Session currency logical source changed");
    });
  },
);
