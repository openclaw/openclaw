import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { onSessionIdentityMutation } from "./session-accessor.js";
import {
  readUnchangedLifecycleTargetSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  loadExactSessionEntry,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { listSessionParticipantsReadOnly } from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";

const tempDirs = createTempDirTracker();
const sessionKey = "agent:main:entry-revalidation";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
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
    await upsertSessionEntryCore(scope, {
      label: "original",
      sessionId: "session-1",
      updatedAt: 10,
    });
    database = openOpenClawAgentDatabase({ agentId: "main", env });
  });

  /** Simulate another writer landing between patch preparation and its commit. */
  function mutateRowOutOfBand(patch: Record<string, string>): void {
    const other = new DatabaseSync(database.path);
    try {
      const entries = Object.entries(patch);
      const setters = entries.map(([key]) => `'$.${key}', ?`).join(", ");
      other
        .prepare(
          `UPDATE session_nodes SET entry_json = json_set(entry_json, ${setters}) WHERE session_key = ?`,
        )
        .run(...entries.map(([, value]) => value), sessionKey);
    } finally {
      other.close();
    }
  }

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
            storePath: database.path,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          },
          update,
          options,
        );
  }

  it.each([false, true])(
    "commits an unchanged persisted row after preparation (reopen: %s)",
    async (reopen) => {
      const persisted = await patchEntry("ordinary", () => {
        if (reopen) {
          expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        }
        return { label: "renamed" };
      });
      expect(persisted).toMatchObject({ label: "renamed", sessionId: "session-1" });
      expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
        label: "renamed",
        sessionId: "session-1",
      });
    },
  );

  it("rejects the commit when the row changed while the update callback ran", async () => {
    await expect(
      patchSessionEntryCore(scope, () => {
        mutateRowOutOfBand({ label: "other writer" });
        return { label: "stale patch" };
      }),
    ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({ label: "other writer" });
  });

  it("rejects a lifecycle-target patch when the row changed while the update callback ran", async () => {
    await expect(
      patchSessionEntryTarget(
        {
          agentId: scope.agentId,
          storePath: database.path,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        },
        () => {
          mutateRowOutOfBand({ label: "other writer" });
          return { label: "stale patch" };
        },
      ),
    ).rejects.toMatchObject({ name: "SqliteSessionMutationConflictError" });
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({ label: "other writer" });
  });

  describe.each([
    { route: "ordinary", replaceEntry: false },
    { route: "lifecycle", replaceEntry: false },
    { route: "lifecycle", replaceEntry: true },
  ] as const)(
    "canonical validation for $route patches (replacement: $replaceEntry)",
    ({ route, replaceEntry }) => {
      it.each([false, true])(
        "rejects invalidated main keys even when the target row is unchanged (no-op: %s)",
        async (noop) => {
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
                expect(
                  database.db
                    .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
                    .get(sessionKey),
                ).toEqual(before);
                return noop ? null : { ...entry, label: "must not commit" };
              },
              replaceEntry,
            ),
          ).rejects.toThrow("openclaw doctor --fix");

          setCanonicalSqliteSessionMainKey(database, "main");
          expect(loadExactSessionEntry(scope)?.entry.label).toBe("original");
        },
      );
    },
  );

  it.each([false, true])(
    "keeps the exact-replacement reader exception after main-key invalidation (no-op: %s)",
    async (noop) => {
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:main" },
        { sessionId: "main-session", updatedAt: 10 },
      );
      const result = await patchEntry(
        "ordinary",
        (entry) => {
          setCanonicalSqliteSessionMainKey(database, "work");
          return noop ? null : { ...entry, label: "exact replacement" };
        },
        true,
      );
      expect(result?.label).toBe(noop ? "original" : "exact replacement");
      setCanonicalSqliteSessionMainKey(database, "main");
      expect(loadExactSessionEntry(scope)?.entry.label).toBe(
        noop ? "original" : "exact replacement",
      );
    },
  );

  it.each(["ordinary", "lifecycle"] as const)(
    "rejects a no-op %s patch after reopening with an invalid main key",
    async (route) => {
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:main" },
        { sessionId: "main-session", updatedAt: 10 },
      );
      await expect(
        patchEntry(route, () => {
          setCanonicalSqliteSessionMainKey(database, "work");
          expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
          return null;
        }),
      ).rejects.toThrow("openclaw doctor --fix");
      // Test cleanup must not depend on admitting the deliberately invalid store.
      closeOpenClawAgentDatabaseByPath(database.path);
      const cleanup = new DatabaseSync(database.path);
      try {
        setCanonicalSqliteSessionMainKey({ db: cleanup }, "main");
      } finally {
        cleanup.close();
      }
      expect(loadExactSessionEntry(scope)?.entry.label).toBe("original");
    },
  );

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

  it.each([false, true])(
    "preserves separately committed participants through patch and reopen (raw projection changed: %s)",
    async (changeProjection) => {
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
        if (changeProjection) {
          database.db
            .prepare("UPDATE session_nodes SET display_name = ? WHERE session_key = ?")
            .run("projection-only", sessionKey);
          expect(
            database.db
              .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
              .get(sessionKey),
          ).toEqual({ ...before, display_name: "projection-only" });
        }
        expect(loadExactSessionEntry(scope)?.entry.label).toBe("original");
        return { label: "with participants" };
      });
      expect(persisted).toMatchObject({ sessionId: "session-1", label: "with participants" });
      expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
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
    },
  );

  it("requires a hydrated read when a prepared entry has no persisted row snapshot", () => {
    const selected = loadExactSessionEntry(scope);
    expect(selected).toBeDefined();
    if (!selected) {
      throw new Error("Expected seeded session entry");
    }
    expect(readUnchangedLifecycleTargetSnapshot(database, [selected])).toBeUndefined();
  });

  it("rejects a lifecycle target selected under a different stored key", async () => {
    await expect(
      patchSessionEntryTarget(
        {
          agentId: scope.agentId,
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

  it("still publishes an identity replacement when a patch rotates the session id", async () => {
    const mutations: unknown[] = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      await patchSessionEntryCore(scope, () => ({ sessionId: "session-2" }));
    } finally {
      unsubscribe();
    }
    expect(mutations).toContainEqual(
      expect.objectContaining({
        kind: "replace",
        previous: expect.objectContaining({ sessionId: "session-1", sessionKeys: [sessionKey] }),
        current: expect.objectContaining({ sessionId: "session-2", sessionKeys: [sessionKey] }),
      }),
    );
  });

  it("does not publish an identity mutation when a patch keeps the session id", async () => {
    const mutations: unknown[] = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      await patchSessionEntryCore(scope, () => ({ updatedAt: 20 }));
    } finally {
      unsubscribe();
    }
    expect(mutations).toEqual([]);
  });
});
