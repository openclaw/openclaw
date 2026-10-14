import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readSqliteBusyTimeout, setSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import {
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteWithYieldingAdmission } from "../../state/openclaw-agent-db-transaction.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { listSessionParticipantsReadOnly } from "./session-accessor.sqlite-participant-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { assertSessionEntryCurrentAdmission } from "./session-entry-current-admission.js";
import {
  readSessionEntryCurrentFacts,
  requestSessionEntryCurrentAdmission,
} from "./session-entry-current-admission.worker.js";
import type {
  SessionEntryCurrentFacts,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";

const tempDirs = createTempDirTracker();
const sessionKey = "agent:main:entry-revalidation";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  tempDirs.cleanup();
});

describe("SQLite session entry patch commit revalidation", () => {
  let env: NodeJS.ProcessEnv;
  let scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };
  let database: ReturnType<typeof openOpenClawAgentDatabase>;

  beforeEach(async () => {
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-entry-revalidation-")),
    };
    scope = { agentId: "main", env, sessionKey };
    setRuntimeConfigSnapshot({});
    await upsertSessionEntryCore(scope, {
      label: "original",
      sessionId: "session-1",
      updatedAt: 10,
    });
    database = openOpenClawAgentDatabase({ agentId: "main", env });
  });

  it.each(["native", "worker"] as const)(
    "publishes the %s patch's exact transcript predicate and rereads a sibling generation next time",
    async (route) => {
      const appended = appendTranscriptMessageSync(
        { ...scope, sessionId: "session-1" },
        { message: { role: "user", content: "receipt source" } },
      );
      if (!appended.ok || !appended.value?.anchor) {
        throw new Error("Expected committed transcript anchor");
      }
      const anchor = appended.value.anchor;
      const onCommitted = vi.fn();
      const options = {
        skipMaintenance: true,
        onCommitted,
        ...(route === "native" ? { assertCommitAllowed: () => {} } : {}),
        workerGuard: {
          shouldCommitIf: {
            kind: "transcript" as const,
            sessionId: "session-1",
            generation: anchor.generation,
            leafEntryId: anchor.entryId,
          },
        },
      };
      await expect(
        patchSessionEntryCore(scope, () => ({ label: "committed" }), options),
      ).resolves.toMatchObject({ label: "committed" });
      expect(onCommitted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ label: "committed" }),
        {
          sessionId: "session-1",
          watermark: { generation: anchor.generation, maxSeq: anchor.rawSeq },
        },
      );
      const sibling = openNodeSqliteDatabase(database.path);
      try {
        sibling
          .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
          .run("sibling-rewrite", "session-1");
      } finally {
        sibling.close();
      }
      await expect(
        patchSessionEntryCore(scope, () => ({ label: "must not commit" }), options),
      ).resolves.toBeNull();
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(loadExactSessionEntry(scope)?.entry.label).toBe("committed");
      onCommitted.mockClear();
      await patchSessionEntryCore(scope, () => ({ sessionId: "rotated-session" }), {
        ...options,
        workerGuard: {
          shouldCommitIf: { ...options.workerGuard.shouldCommitIf, generation: "sibling-rewrite" },
        },
      });
      expect(onCommitted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: "rotated-session" }),
      );
    },
  );

  function patchEntry(
    route: "ordinary" | "lifecycle",
    update: Parameters<typeof patchSessionEntryCore>[1],
    replaceEntry = false,
  ) {
    const options = { replaceEntry, skipMaintenance: true };
    return route === "ordinary"
      ? patchSessionEntryCore(scope, update, options)
      : patchSessionEntryTarget(
          {
            agentId: scope.agentId,
            env: scope.env,
            storePath: database.path,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          },
          update,
          options,
        );
  }

  function setUnrelatedParent(db: DatabaseSync, parentSessionKey: string | null): void {
    db.prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?").run(
      parentSessionKey,
      "agent:main:main",
    );
  }

  it("yields to the event loop while another connection holds the entry write lock", async () => {
    const other = new DatabaseSync(database.path);
    // Bound the defective synchronous path without a timer or a timing assertion.
    setSqliteBusyTimeout(database.db, 250);
    let release: Promise<void> | undefined;
    try {
      const result = await patchEntry("ordinary", () => {
        other.exec("BEGIN IMMEDIATE");
        release = setImmediate().then(() => other.exec("ROLLBACK"));
        return { label: "after contention" };
      });
      expect(result?.label).toBe("after contention");
      expect(loadExactSessionEntry(scope)?.entry.label).toBe("after contention");
    } finally {
      await release;
      other.close();
    }
  });

  it("restores the connection's commit wait after admitting a rollback-journal write", async () => {
    await closeOpenClawAgentDatabasesAsync();
    database = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(database.db.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode).toBe("delete");
    setSqliteBusyTimeout(database.db, 37);
    const reader = new DatabaseSync(database.path);
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT session_key FROM session_nodes").get();
      const patched = await runOpenClawAgentWriteWithYieldingAdmission(
        (writer) => {
          expect(writer.db.isTransaction).toBe(true);
          expect(reader.isTransaction).toBe(true);
          expect(readSqliteBusyTimeout(writer.db)).toBe(37);
          reader.exec("ROLLBACK");
          return writeSessionEntry(writer, sessionKey, {
            sessionId: "session-1",
            updatedAt: 10,
            label: "after reader",
          });
        },
        { agentId: "main", env },
      );
      expect(patched?.label).toBe("after reader");
      expect(
        reader
          .prepare(
            "SELECT json_extract(entry_json, '$.label') AS label FROM session_nodes WHERE session_key = ?",
          )
          .get(sessionKey),
      ).toEqual({ label: "after reader" });
    } finally {
      if (reader.isTransaction) {
        reader.exec("ROLLBACK");
      }
      reader.close();
    }
  });

  it.each(["authority", "row", "connection"] as const)(
    "rejects a changed %s after yielding for the entry write lock",
    async (changed) => {
      const other = new DatabaseSync(database.path);
      let current = true;
      let updates = 0;
      let release: Promise<void> | undefined;
      try {
        const patch = patchSessionEntryCore(
          scope,
          () => {
            updates += 1;
            other.exec("BEGIN IMMEDIATE");
            release = setImmediate().then(() => {
              if (changed === "row") {
                other
                  .prepare(
                    "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'foreign') WHERE session_key = ?",
                  )
                  .run(sessionKey);
              }
              other.exec("COMMIT");
              current = false;
              if (changed === "connection") {
                closeOpenClawAgentDatabaseByPath(database.path);
              }
            });
            return { label: "must not commit" };
          },
          {
            skipMaintenance: true,
            assertCommitAllowed: () => {
              if (changed === "authority" && !current) {
                throw new Error("patch authority revoked");
              }
            },
          },
        );
        await expect(patch).rejects.toThrow(
          changed === "authority"
            ? "patch authority revoked"
            : changed === "row"
              ? /changed/
              : /closed|replaced|not open/,
        );
        expect(updates).toBe(1);
        if (changed === "connection") {
          await closeOpenClawAgentDatabaseByPathAsync(database.path);
        }
        expect(loadExactSessionEntry(scope)?.entry.label).toBe(
          changed === "row" ? "foreign" : "original",
        );
      } finally {
        await release;
        other.close();
      }
    },
  );

  describe("compact session currency facts", () => {
    function readCurrentEntryThroughAdmission(native: OpenClawAgentReadOnlyDatabase) {
      const identity = readOpenClawAgentDatabaseIdentity(native);
      if (typeof identity.identity !== "string") {
        throw new Error("Expected the fixture's durable database identity");
      }
      const source: SessionEntryCurrentSource = {
        agentId: native.agentId,
        path: native.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
        sessionKey,
      };
      let entry: SessionEntryCurrentFacts | undefined;
      requestSessionEntryCurrentAdmission(
        source,
        { stage: "commit", facts: undefined },
        { database: native },
        (request) => {
          assertSessionEntryCurrentAdmission(request, {
            source,
            assertCurrent: (facts) => {
              entry = facts;
            },
          });
        },
      );
      return entry;
    }

    it("discards facts first observed after a write in a rolled-back native transaction", () => {
      // A fresh admitted connection has never installed the lazy revision tracker.
      const connection = openNodeSqliteDatabase(database.path);
      registerOpenClawAgentDatabaseIdentity(connection);
      admitSqliteSchema(connection);
      const native = { agentId: database.agentId, path: database.path, db: connection };
      const rollback = new Error("roll back first compact read");
      try {
        expect(() =>
          withSqlitePostCommitPublications(connection, () => {
            connection.exec("BEGIN");
            try {
              connection
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRunId', ?) WHERE session_key = ?",
                )
                .run("uncommitted-owner", sessionKey);
              expect(readCurrentEntryThroughAdmission(native)).toMatchObject({
                lifecycleRunId: "uncommitted-owner",
              });
              throw rollback;
            } finally {
              connection.exec("ROLLBACK");
            }
          }),
        ).toThrow(rollback);
        expect(readCurrentEntryThroughAdmission(native)).toMatchObject({
          sessionId: "session-1",
          lifecycleRunId: undefined,
        });
      } finally {
        connection.close();
      }
    });

    it.each(["sibling", "same-connection"] as const)(
      "refreshes a cached owner after a %s change and preserves rollback",
      (writer) => {
        const original = readCurrentEntryThroughAdmission(database);
        expect(original).toEqual({
          sessionId: "session-1",
          lifecycleRevision: undefined,
          lifecycleRunId: undefined,
          activeWriterRunId: undefined,
        });
        const update = (connection: DatabaseSync) =>
          connection
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRunId', ?, '$.subagentRecovery.lastRunId', ?) WHERE session_key = ?",
            )
            .run("next-lifecycle", "hidden-successor", sessionKey);
        if (writer === "sibling") {
          const other = openNodeSqliteDatabase(database.path);
          try {
            update(other);
          } finally {
            other.close();
          }
        } else {
          database.db.exec("BEGIN");
          update(database.db);
        }
        try {
          expect(readCurrentEntryThroughAdmission(database)).toMatchObject({
            lifecycleRunId: "next-lifecycle",
            subagentRecovery: { lastRunId: "hidden-successor" },
          });
        } finally {
          if (writer === "same-connection") {
            database.db.exec("ROLLBACK");
          }
        }
        if (writer === "same-connection") {
          expect(readCurrentEntryThroughAdmission(database)).toEqual(original);
        }
      },
    );

    it("preserves parser values and last duplicate owner fields through native admission", () => {
      readCurrentEntryThroughAdmission(database);
      const other = openNodeSqliteDatabase(database.path);
      try {
        other
          .prepare(
            "UPDATE session_nodes SET entry_json = substr(entry_json, 1, length(entry_json) - 1) || ? WHERE session_key = ?",
          )
          .run(
            ',"lifecycleRevision":42,"lifecycleRunId":"old","lifecycleRunId":null,"activeWriterRunId":false,"subagentRecovery":{"lastRunId":23,"sessionLifecycleRunId":null}}',
            sessionKey,
          );
      } finally {
        other.close();
      }
      const entry = readCurrentEntryThroughAdmission(database);
      const expected = {
        sessionId: "session-1",
        lifecycleRevision: 42,
        lifecycleRunId: null,
        activeWriterRunId: false,
        subagentRecovery: { lastRunId: 23, sessionLifecycleRunId: null },
      };
      expect(entry).toEqual(expected);
      const identity = readOpenClawAgentDatabaseIdentity(database);
      if (typeof identity.identity !== "string") {
        throw new Error("Expected the fixture's durable database identity");
      }
      const source: SessionEntryCurrentSource = {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
        sessionKey,
      };
      let observed: unknown;
      expect(
        assertSessionEntryCurrentAdmission(
          {
            stage: "commit",
            facts: { kind: "session-entry-current", source, entry, domainFacts: "write-1" },
          },
          { source, assertCurrent: (facts) => (observed = facts) },
        ),
      ).toEqual({ stage: "commit", facts: "write-1" });
      expect(observed).toEqual(expected);
    });

    it("refuses a captured source replaced by identical database bytes", async () => {
      const original = readCurrentEntryThroughAdmission(database);
      const identity = readOpenClawAgentDatabaseIdentity(database);
      if (typeof identity.identity !== "string") {
        throw new Error("Expected the fixture's durable database identity");
      }
      const source: SessionEntryCurrentSource = {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
        sessionKey,
      };
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      const bytes = fs.readFileSync(database.path);
      fs.renameSync(database.path, `${database.path}.original`);
      fs.writeFileSync(database.path, bytes, { mode: 0o600 });
      expect(fs.readFileSync(database.path)).toEqual(bytes);
      const request = {
        kind: "session-entry-current" as const,
        database: { agentId: "main", path: database.path },
        scope: { ...scope, databaseAgentId: "main", storePath: database.path },
      };
      expect(() => readSessionEntryCurrentFacts({ ...request, source })).toThrow();
      expect(readSessionEntryCurrentFacts(request).entry).toEqual(original);
    });
  });

  it("commits an unchanged persisted row after evicting the host handle during preparation", async () => {
    const persisted = await patchEntry("ordinary", () => {
      closeCachedOpenClawAgentDatabase(database);
      expect(database.db.isOpen).toBe(false);
      return { label: "renamed" };
    });
    expect(persisted).toMatchObject({ label: "renamed", sessionId: "session-1" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
      label: "renamed",
      sessionId: "session-1",
    });
  });

  it.each([
    { route: "ordinary", replaceEntry: false },
    { route: "lifecycle", replaceEntry: true },
  ] as const)(
    "revalidates unrelated lineage for $route patches (replacement: $replaceEntry)",
    async ({ route, replaceEntry }) => {
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:main" },
        { sessionId: "main-session", updatedAt: 10 },
      );
      const before = database.db
        .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
        .get(sessionKey);

      await expect(
        patchEntry(
          route,
          (entry) => {
            setCanonicalSqliteSessionMainKey(database, "work");
            setUnrelatedParent(database.db, "agent:main:unrecorded-parent");
            expect(
              database.db
                .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
                .get(sessionKey),
            ).toEqual(before);
            return { ...entry, label: "must not commit" };
          },
          replaceEntry,
        ),
      ).rejects.toThrow("openclaw doctor --fix");

      setUnrelatedParent(database.db, null);
      expect(loadExactSessionEntry(scope)?.entry.label).toBe("original");
    },
  );

  it("keeps the exact-replacement reader exception after unrelated lineage invalidation", async () => {
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:main" },
      { sessionId: "main-session", updatedAt: 10 },
    );
    const result = await patchEntry(
      "ordinary",
      (entry) => {
        setCanonicalSqliteSessionMainKey(database, "work");
        setUnrelatedParent(database.db, "agent:main:unrecorded-parent");
        return { ...entry, label: "exact replacement" };
      },
      true,
    );
    expect(result?.label).toBe("exact replacement");
    setUnrelatedParent(database.db, null);
    expect(loadExactSessionEntry(scope)?.entry.label).toBe("exact replacement");
  });

  it("rejects a no-op lifecycle patch after host eviction with invalidated unrelated lineage", async () => {
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:main" },
      { sessionId: "main-session", updatedAt: 10 },
    );
    await expect(
      patchEntry("lifecycle", () => {
        setCanonicalSqliteSessionMainKey(database, "work");
        setUnrelatedParent(database.db, "agent:main:unrecorded-parent");
        closeCachedOpenClawAgentDatabase(database);
        expect(database.db.isOpen).toBe(false);
        return null;
      }),
    ).rejects.toThrow("openclaw doctor --fix");
    // Test cleanup must not depend on admitting the deliberately invalid store.
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const cleanup = new DatabaseSync(database.path);
    try {
      setUnrelatedParent(cleanup, null);
    } finally {
      cleanup.close();
    }
    expect(loadExactSessionEntry(scope)?.entry.label).toBe("original");
  });

  it("rejects an intervening owner assignment even when entry JSON is unchanged", async () => {
    assignSessionOwner(scope, {
      owner: { type: "agent", id: "original-owner" },
      assignedBy: { type: "human", id: "assigner" },
      assignedAt: 10,
    });
    const before = database.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey);
    await expect(
      patchEntry("ordinary", () => {
        expect(
          assignSessionOwner(scope, {
            owner: { type: "agent", id: "new-owner" },
            assignedBy: { type: "human", id: "assigner" },
            assignedAt: 20,
          }),
        ).not.toBeNull();
        expect(
          database.db
            .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
            .get(sessionKey),
        ).toEqual(before);
        return { label: "must not commit" };
      }),
    ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
      label: "original",
      owner: { actor: { type: "agent", id: "new-owner" }, assignedAt: 20 },
    });
  });

  it("preserves separately committed participants through patch and reopen with unchanged row projection", async () => {
    recordSessionParticipant(scope, {
      identity: { type: "agent", id: "existing" },
      promptedAt: 10,
    });
    const persisted = await patchEntry("ordinary", () => {
      const before = database.db
        .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
        .get(sessionKey);
      expect(
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "new-participant" },
          promptedAt: 20,
        }),
      ).toBe("inserted");
      expect(
        database.db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(sessionKey),
      ).toEqual(before);
      expect(loadExactSessionEntry(scope)?.entry.label).toBe("original");
      return { label: "with participants" };
    });
    expect(persisted).toMatchObject({ sessionId: "session-1", label: "with participants" });
    expect(await closeOpenClawAgentDatabaseByPathAsync(database.path)).toBe(true);
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
      label: "with participants",
      participantCount: 2,
      participants: expect.arrayContaining([
        expect.objectContaining({ identity: { type: "agent", id: "existing" } }),
        expect.objectContaining({ identity: { type: "agent", id: "new-participant" } }),
      ]),
    });
    database = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(listSessionParticipantsReadOnly(scope).get(sessionKey)).toEqual([
      {
        identity: { type: "agent", id: "existing" },
        contributionCount: 1,
        firstPromptedAt: 10,
        lastPromptedAt: 10,
      },
      {
        identity: { type: "agent", id: "new-participant" },
        contributionCount: 1,
        firstPromptedAt: 20,
        lastPromptedAt: 20,
      },
    ]);
    expect(
      database.db
        .prepare(
          "SELECT json_type(entry_json, '$.participants') AS participants, json_type(entry_json, '$.participantCount') AS participant_count FROM session_nodes WHERE session_key = ?",
        )
        .get(sessionKey),
    ).toEqual({ participants: null, participant_count: null });
  });

  it("rejects a lifecycle target selected under a different stored key", async () => {
    await expect(
      patchSessionEntryTarget(
        {
          agentId: scope.agentId,
          env: scope.env,
          storePath: database.path,
          target: { canonicalKey: "agent:main:different-target", storeKeys: [sessionKey] },
        },
        () => ({ label: "must not move" }),
        { skipMaintenance: true },
      ),
    ).rejects.toThrow(
      "non-canonical persisted row resolves to session key agent:main:different-target",
    );
    expect(loadExactSessionEntry(scope)?.entry.label).toBe("original");
    expect(
      loadExactSessionEntry({ ...scope, sessionKey: "agent:main:different-target" }),
    ).toBeUndefined();
  });

  it("preserves canonical creation policy when the writer receives an unrelated previous entry", async () => {
    const requiredScope = { ...scope, sessionKey: "agent:main:required-creation" };
    const stamp = {
      sandbox: "required" as const,
      createdVia: "operator" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "creator" },
      createdAt: 10,
    };
    await upsertSessionEntryCore(requiredScope, {
      sessionId: "required-session",
      updatedAt: 10,
      ...stamp,
    });
    const previousEntry = loadExactSessionEntry(scope)?.entry;
    expect(previousEntry?.sessionId).toBe("session-1");
    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        writeSessionEntry(
          writeDatabase,
          requiredScope.sessionKey,
          {
            sessionId: "required-session",
            updatedAt: 20,
            label: "updated",
            createdVia: "plugin",
            createdAt: 20,
          },
          { previousEntry },
        );
      },
      { agentId: "main", env },
    );
    expect(loadExactSessionEntry(requiredScope)?.entry).toMatchObject({
      sessionId: "required-session",
      label: "updated",
      ...stamp,
    });
  });
});
