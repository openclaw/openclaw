import fs, {
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as admissionReceipts from "../../infra/sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { NativeWorker } from "../../infra/worker-native-handle.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  invalidateRegisteredAgentDatabasesMemo,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "../../state/openclaw-agent-db-registry-listing.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { observeMainThreadFs } from "../../test-utils/main-thread-fs-spies.test-support.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as entryReads from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  loadSessionEntryReadOnlyInScope,
  loadSessionEntryReadOnlyResultInScope,
  replaceSessionEntrySync,
  patchSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { assertSessionEntryCurrentAdmission } from "./session-entry-current-admission.js";
import { captureSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import type { SessionEntryCurrentCheck } from "./session-entry-current.types.js";
import { readSessionEntryList } from "./session-entry-list.worker.js";
import {
  readSessionEntryReadOnlyInWorker,
  readSessionEntriesFromStoreInWorker,
  withSessionEntryReadOnlyInWorker,
} from "./session-entry-read-runtime.js";
import { readSessionRuntimeTargetWorkerRequest } from "./session-runtime-target-read.worker.js";
import { readSessionStoreTargetResult } from "./session-store-target-inventory.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import * as historyWorker from "./session-transcript-worker-runtime.js";

const sqliteError = (message: string, errcode = 26) =>
  Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode });
const databaseTarget = ({ agentId, path }: { agentId: string; path: string }) => ({
  agentId,
  path,
});
const sessionEntry = (sessionId = "original") => ({ sessionId, updatedAt: 1 });

function createEntryFixture(env: NodeJS.ProcessEnv) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const sessionKey = "agent:main:readonly-entry";
  writeSessionEntry(database, sessionKey, sessionEntry());
  const scope = {
    agentId: "main",
    databaseAgentId: "main",
    storePath: database.path,
    sessionKey,
    env,
  };
  return { database, scope };
}

it("hydrates only selected entries in a worker listing", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { database, scope } = createEntryFixture(env);
    for (let index = 0; index < 32; index++) {
      writeSessionEntry(database, `agent:main:unrelated-${index}`, {
        sessionId: `unrelated-${index}`,
        updatedAt: 1,
      });
    }
    using parsed = vi.spyOn(JSON, "parse");
    const result = await readSessionEntryList({
      kind: "session-entry-list",
      database: databaseTarget(database),
      scope: { ...scope, sessionKeys: [scope.sessionKey], projection: "full" },
    });
    expect(result.entries).toMatchObject([{ sessionKey: scope.sessionKey, entry: sessionEntry() }]);
    expect(
      parsed.mock.calls.filter(([json]) => json.includes('"sessionId":"unrelated-')),
    ).toHaveLength(0);
  }));

it("reuses listing revisions and invalidates sibling edits and reopened readers", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:catalog-revision";
    const listed = (category: string) => [{ sessionKey, entry: { updatedAt: 1, category } }];
    writeSessionEntry(database, sessionKey, {
      sessionId: "catalog-session",
      updatedAt: 1,
      category: "Team",
    });
    const target = databaseTarget(database);
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
      const originalRevision = await retained.run(target, async () => {
        const first = await read();
        expect(first.entries).toMatchObject(listed("Team"));
        expect(first.revision).toBeTypeOf("string");
        expect(await read(first.revision)).toMatchObject({
          entries: [],
          unchanged: true,
          revision: first.revision,
          source: first.source,
        });
        runSqliteImmediateTransactionSync(peer, () => {
          peer
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.category', 'Private') WHERE session_key = ?",
            )
            .run(sessionKey);
          // This category-only edit preserves the writer-validated identity and lineage.
          peer
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run(sessionKey);
        });
        const changed = await read(first.revision);
        expect(changed.entries).toMatchObject(listed("Private"));
        expect(changed.revision).not.toBe(first.revision);
        expect(changed.unchanged).toBeUndefined();
        return first.revision;
      });
      retained.close();
      await retained.run(target, async () => {
        // A new connection can reuse the original SQLite counters, but never its revision.
        const reopened = await read(originalRevision);
        expect(reopened.revision).not.toBe(originalRevision);
        expect(reopened.unchanged).toBeUndefined();
        expect(reopened.entries).toMatchObject(listed("Private"));
      });
    } finally {
      retained.close();
      peer.close();
    }
  }));

it("resolves runtime targets and refuses replacement by a newer schema", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionId = "runtime-target-session";
    const sessionKey = "agent:main:persisted-target";
    replaceSessionEntrySync({ agentId: "main", env, sessionKey }, sessionEntry(sessionId));
    const read = (
      agentId = "main",
      selectedId = sessionId,
      key = "agent:main:fallback",
      keyFormat?: "agent-qualified",
    ) =>
      readSessionRuntimeTargetWorkerRequest({
        kind: "session-runtime-target",
        database: databaseTarget(database),
        scope: { agentId, env, sessionId: selectedId, sessionKey: key, storePath: database.path },
        keyFormat,
      });
    expect(read()).toMatchObject({
      kind: "session-runtime-target",
      target: { agentId: "main", sessionId, sessionKey, storePath: database.path },
      source: { agentId: database.agentId, path: database.path },
    });

    const logicalKey = "agent:helper:runtime-fallback";
    writeSessionEntry(database, logicalKey, {
      sessionId: "helper-current",
      lifecycleRevision: "helper-lifecycle",
      updatedAt: 1,
    });
    expect(read("helper", "missing-window", "runtime-fallback", "agent-qualified")).toMatchObject({
      target: {
        agentId: "helper",
        sessionId: "missing-window",
        sessionKey: logicalKey,
        selectedSessionId: "helper-current",
        selectedLifecycleRevision: "helper-lifecycle",
      },
      source: { agentId: "main", path: database.path },
    });

    const replacement = `${database.path}.replacement`;
    await backup(requireNativeSqliteDatabase(database.db), replacement);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const peer = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(replacement);
    try {
      peer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
    } finally {
      peer.close();
    }
    renameSync(replacement, database.path);
    expect(() => read()).toThrow("newer schema version");
  }));

it("reads session projections in the worker and observes the next sibling commit", () =>
  withOpenClawTestState({ label: "readonly-entry-projection-boundary" }, async ({ env }) => {
    const { database, scope } = createEntryFixture(env);
    const before = await readSessionEntryReadOnlyInWorker(scope);
    expect(before).toMatchObject({ sessionId: "original" });
    using peer = nodeSqlite.openNodeSqliteDatabase(database.path);

    peer
      .prepare(
        `INSERT INTO session_participants
           (session_key, identity_namespace, actor_id, contribution_count)
           VALUES (?, ?, ?, 1)`,
      )
      .run(scope.sessionKey, JSON.stringify({ type: "profile" }), "sibling-participant");
    const after = await readSessionEntryReadOnlyInWorker(scope);
    expect(after).toMatchObject({
      sessionId: "original",
      participants: [{ identity: { type: "profile", id: "sibling-participant" } }],
      participantCount: 1,
    });
    expect(before?.participants).toBeUndefined();
  }));

it.each([false, true])(
  "returns unreadable-store data only after its connection closes (close failure: %s)",
  (failClose) =>
    withOpenClawTestState({ label: "readonly-entry-open-failure" }, async ({ env, path }) => {
      const storePath = path("unreadable.sqlite");
      writeFileSync(storePath, "Not a SQLite database");
      const closeError = sqliteError("native read close failed");
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
    }),
);

it.each(["schema-retained", "schema-disposable", "row", "rollback"] as const)(
  "classifies selected-row failures only after reader cleanup: %s",
  (mode) =>
    withOpenClawTestState({ label: "readonly-entry-error" }, async ({ env }) => {
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
        ? sqliteError("native selected-row query failed", 1)
        : new Error("selected row could not be decoded");
      let reader: typeof database.db | undefined;
      const read = vi
        .spyOn(entryReads, "readSessionEntrySelectionInDatabase")
        .mockImplementation((source) => {
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
    }),
);

it("keeps source refusal outside the ordinary row-error result", () =>
  withOpenClawTestState({ label: "readonly-entry-source" }, async ({ env }) => {
    const { scope } = createEntryFixture(env);
    const refusal = sqliteError("retained source changed");
    expect(() =>
      loadSessionEntryReadOnlyResultInScope(scope, undefined, () => {
        throw refusal;
      }),
    ).toThrow(refusal);
  }));

it("propagates raw worker failure without calling the optional-data consumer", () =>
  withOpenClawTestState({ label: "readonly-entry-transport" }, async ({ env, path }) => {
    const failure = new Error("worker could not start");
    using _ = vi.spyOn(targetDiscoveryLane.pool, "run").mockRejectedValueOnce(failure);
    const consume = vi.fn(async () => undefined);

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
  }));

it("retains the scoped registry witness even when the first read rejects before returning a snapshot", () =>
  withOpenClawTestState({ label: "readonly-registry-witness" }, async ({ env }) => {
    const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env }, () => false);
    const pending = prepared.read();
    invalidateRegisteredAgentDatabasesMemo({ env });
    await expect(pending).rejects.toThrow("registry changed");
    expect(() => prepared.assertCurrent()).toThrow("registry changed");
  }));

it("returns unavailable registry facts as locator data without catching candidate escape", () =>
  withOpenClawTestState({ label: "readonly-target-result" }, async ({ env, path }) => {
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
  }));

it.runIf(process.platform !== "win32").each([
  { retarget: true, logicalAgentId: "main", canonical: false },
  { retarget: false, logicalAgentId: "ops", canonical: false },
  { retarget: true, logicalAgentId: "main", canonical: true },
])(
  "retains logical $logicalAgentId through its consumer (retargeted: $retarget, canonical: $canonical)",
  async ({ retarget, logicalAgentId, canonical }) => {
    await withOpenClawTestState({ label: "readonly-store-alias" }, async ({ env, path }) => {
      const original = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = `agent:${logicalAgentId}:alias`;
      writeSessionEntry(original, sessionKey, sessionEntry());
      if (logicalAgentId !== "main") {
        writeSessionEntry(original, "agent:main:alias", sessionEntry("other-agent"));
      }
      const replacement = retarget
        ? openOpenClawAgentDatabase({ agentId: "main", path: path("replacement.sqlite"), env })
        : undefined;
      const alias = canonical ? original.path : path("custom.sqlite");
      if (!canonical) {
        symlinkSync(original.path, alias);
      }
      const moved = path("original.sqlite");
      let consumed = false;
      const pending = withSessionEntryReadOnlyInWorker(
        {
          agentId: logicalAgentId,
          sessionKey,
          storePath: canonical
            ? original.path
            : logicalAgentId === "main"
              ? path("custom.json")
              : alias,
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
            if (canonical) {
              renameSync(alias, moved);
            } else {
              unlinkSync(alias);
            }
            symlinkSync(replacement.path, alias);
          }
          return read.value;
        },
      );
      if (retarget) {
        await expect(pending).rejects.toThrow(
          "Session database target changed outside captured discovery custody",
        );
      } else {
        await expect(pending).resolves.toMatchObject({ sessionId: "original" });
      }
      if (canonical) {
        unlinkSync(alias);
        renameSync(moved, alias);
      }
      expect(consumed).toBe(true);
    });
  },
);

it.each(["logical", "omitted", "empty", "handoff"] as const)(
  "fences the selected SQLite alias after a %s store read releases its initial owner",
  (locator) =>
    withOpenClawTestState({ label: "currency-selected-store-alias" }, async (state) => {
      const openAt = (name: string) =>
        openOpenClawAgentDatabase({
          agentId: "main",
          path: state.statePath(name, "openclaw-agent.sqlite"),
          env: state.env,
        });
      const original = openAt("original");
      const replacement = openAt("replacement");
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
          const stat = vi.spyOn(fs, "statSync");
          const realpath = vi.spyOn(fs.realpathSync, "native");
          syncBuiltinESMExports();
          try {
            const captured = captureSessionEntryCurrentRead(scope, owner);
            captured.assertSourceCurrent();
            expect(stat).not.toHaveBeenCalled();
            expect(realpath).not.toHaveBeenCalled();
            return captured;
          } finally {
            stat.mockRestore();
            realpath.mockRestore();
            syncBuiltinESMExports();
          }
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
      const retarget = () => {
        rmSync(alias, { recursive: true, force: true });
        symlinkSync(dirname(replacement.path), alias, linkType);
        expect(realpathSync(state.sessionsDir())).toBe(logicalParent);
        expect(realpathSync(selectedSqlite)).toBe(realpathSync(replacement.path));
      };
      if (locator === "handoff") {
        const readHistory = historyWorker.withSessionHistoryWorkerDatabase;
        vi.spyOn(historyWorker, "withSessionHistoryWorkerDatabase").mockImplementationOnce(
          async (...args) => {
            const value = await readHistory(...args);
            retarget();
            return value;
          },
        );
      } else {
        retarget();
      }
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
      rmSync(alias, { recursive: true, force: true });
      symlinkSync(dirname(original.path), alias, linkType);
      await expect(current.readCurrent()).resolves.toMatchObject({ sessionId: entry.sessionId });
      expect(() => current.assertSourceCurrent()).not.toThrow();
    }),
);

it.each(["single", "batch"] as const)(
  "admits cold %s reads through their worker before retaining invalidation facts",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { database, scope } = createEntryFixture(state.env);
      const coldPath = state.path("cold-rows.sqlite");
      await backup(requireNativeSqliteDatabase(database.db), coldPath);
      const cold = { ...scope, storePath: coldPath };
      expect(admissionReceipts.getSqliteDatabaseAdmissionIdentityForPath(coldPath)).toBeUndefined();
      using filesystem = observeMainThreadFs();
      const token = admissionReceipts.readSqliteDatabaseWriteTokenForPath;
      let tokenLookups = 0;
      using observation = vi
        .spyOn(admissionReceipts, "readSqliteDatabaseWriteTokenForPath")
        .mockImplementation((...args) => {
          const before = filesystem.count();
          try {
            return token(...args);
          } finally {
            tokenLookups += filesystem.count() - before;
          }
        });
      using messages = vi.spyOn(NativeWorker.prototype, "postMessage");
      using workerMessages = vi.spyOn(Worker.prototype, "postMessage");
      const requests = () =>
        [...messages.mock.calls, ...workerMessages.mock.calls].filter(
          ([message]) =>
            isRecord(message) &&
            isRecord(message.input) &&
            (message.input.kind === "session-entry-read" ||
              message.input.kind === "session-exact-entries"),
        ).length;
      const read = async () =>
        kind === "single"
          ? readSessionEntryReadOnlyInWorker(cold)
          : (
              await readSessionEntriesFromStoreInWorker({
                ...cold,
                sessionKeys: [scope.sessionKey],
              })
            ).entries[0]?.entry;
      expect(await read()).toMatchObject({ sessionId: "original" });
      const first = requests();
      expect(await read()).toMatchObject({ sessionId: "original" });
      const second = requests();
      expect(await read()).toMatchObject({ sessionId: "original" });
      expect(requests()).toBe(second);
      expect(observation).toHaveBeenCalled();
      expect(tokenLookups).toBe(0);
      expect(first).toBe(1);
      expect(second).toBe(2);
      await patchSessionEntryCore(cold, () => ({ label: "worker-committed" }));
      expect(await read()).toMatchObject({ label: "worker-committed" });
      expect(tokenLookups).toBe(0);
    }),
);
