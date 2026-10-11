import {
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  isSessionNodePayloadSelect,
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  invalidateRegisteredAgentDatabasesMemo,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "../../state/openclaw-agent-db-registry-listing.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
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
import { readSessionEntryList } from "./session-entry-list.worker.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "./session-entry-read-runtime.js";
import { readSessionEntryWorkerRequest } from "./session-entry-read.worker.js";
import { readSessionStoreTargetResult } from "./session-store-target-inventory.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";

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

it("reuses listing revisions without payload scans and invalidates sibling edits and reopened readers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:catalog-revision";
    writeSessionEntry(database, sessionKey, {
      sessionId: "catalog-session",
      updatedAt: 1,
      category: "Team",
    });
    const target = { agentId: database.agentId, path: database.path };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    const peer = nodeSqlite.openNodeSqliteDatabase(target.path);
    const retained = new OpenClawAgentDatabaseReadOnlyScope();
    const read = (ifRevision?: string) =>
      readSessionEntryList({
        kind: "session-entry-list",
        database: target,
        scope: {
          agentId: target.agentId,
          storePath: target.path,
          env,
          projection: "list",
          includeParticipants: false,
        },
        ifRevision,
      });
    try {
      const originalRevision = retained.run(target, () => {
        const first = read();
        expect(first.entries).toMatchObject([
          { sessionKey, entry: { updatedAt: 1, category: "Team" } },
        ]);
        expect(first.revision).toBeTypeOf("string");
        const opened = withOpenClawAgentDatabaseReadOnly((reader) => reader, { ...target, env });
        if (!opened.found) {
          throw new Error("Expected the retained catalog database");
        }
        const payloads = trackSqliteStatementExecutions(opened.value.db, ["entries"], (sql) =>
          isSessionNodePayloadSelect(sql) ||
          (sql.includes('from "session_nodes"') && sql.includes('"entry_json"'))
            ? "entries"
            : null,
        );
        try {
          expect(read(first.revision)).toMatchObject({
            entries: [],
            unchanged: true,
            revision: first.revision,
            source: first.source,
          });
          expect(payloads.counts.entries).toBe(0);
          peer.exec("BEGIN IMMEDIATE");
          try {
            peer
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.category', 'Private') WHERE session_key = ?",
              )
              .run(sessionKey);
            // This category-only edit preserves the writer-validated identity and lineage.
            peer
              .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
              .run(sessionKey);
            peer.exec("COMMIT");
          } catch (error) {
            peer.exec("ROLLBACK");
            throw error;
          }
          const changed = read(first.revision);
          expect(changed.entries).toMatchObject([
            { sessionKey, entry: { updatedAt: 1, category: "Private" } },
          ]);
          expect(changed.revision).not.toBe(first.revision);
          expect(changed.unchanged).toBeUndefined();
          expect(payloads.counts.entries).toBeGreaterThan(0);
          return first.revision;
        } finally {
          payloads.restore();
        }
      });
      retained.close();
      retained.run(target, () => {
        // A new connection can reuse the original SQLite counters, but never its revision.
        const reopened = read(originalRevision);
        expect(reopened.revision).not.toBe(originalRevision);
        expect(reopened.unchanged).toBeUndefined();
        expect(reopened.entries).toMatchObject([
          { sessionKey, entry: { updatedAt: 1, category: "Private" } },
        ]);
      });
    } finally {
      retained.close();
      peer.close();
    }
  });
});

it("resolves runtime targets through an admitted reader without freshness probes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionId = "runtime-target-session";
    const sessionKey = "agent:main:persisted-target";
    replaceSessionEntrySync({ agentId: "main", env, sessionKey }, { sessionId, updatedAt: 1 });
    const read = () =>
      readSessionEntryWorkerRequest({
        kind: "session-runtime-target",
        database: { agentId: database.agentId, path: database.path },
        scope: {
          agentId: "main",
          env,
          sessionId,
          sessionKey: "agent:main:fallback",
          storePath: database.path,
        },
      });
    await read();
    const queries = trackSqliteStatementExecutions(database.db, ["freshness"], (sql) =>
      /^PRAGMA data_version;?$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql)
        ? "freshness"
        : null,
    );
    try {
      expect(await read()).toMatchObject({
        kind: "session-runtime-target",
        target: { agentId: "main", sessionId, sessionKey, storePath: database.path },
        source: { agentId: database.agentId, path: database.path },
      });
      expect(queries.counts.freshness).toBe(0);
    } finally {
      queries.restore();
    }

    const replacement = `${database.path}.replacement`;
    await backup(database.db, replacement);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const peer = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(replacement);
    try {
      peer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
    } finally {
      peer.close();
    }
    renameSync(replacement, database.path);
    await expect(read()).rejects.toThrow("newer schema version");
  });
});

it("reads session projections in the worker and observes the next sibling commit", async () => {
  await withOpenClawTestState({ label: "readonly-entry-projection-boundary" }, async ({ env }) => {
    const { database, scope } = createEntryFixture(env);
    const before = await readSessionEntryReadOnlyInWorker(scope);
    expect(before).toMatchObject({ sessionId: "original" });
    const peer = nodeSqlite.openNodeSqliteDatabase(database.path);
    try {
      peer
        .prepare(
          `INSERT INTO session_participants
           (session_key, identity_namespace, actor_id, contribution_count)
           VALUES (?, ?, ?, 1)`,
        )
        .run(scope.sessionKey, JSON.stringify({ type: "profile" }), "sibling-participant");
      const sql = observeHostDataSql();
      try {
        const after = await readSessionEntryReadOnlyInWorker(scope);
        expect(after).toMatchObject({
          sessionId: "original",
          participants: [{ identity: { type: "profile", id: "sibling-participant" } }],
          participantCount: 1,
        });
        expect(before?.participants).toBeUndefined();
        expect(
          sql.queries.filter((query) => /\bsession_(?:nodes|windows|participants)\b/.test(query)),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
    } finally {
      peer.close();
    }
  });
});

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
    const run = vi.spyOn(targetDiscoveryLane.pool, "run").mockRejectedValueOnce(failure);
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
      const pool = targetDiscoveryLane.pool;
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
