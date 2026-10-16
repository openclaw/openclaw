import { expect, it } from "vitest";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction as transaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction as stateTransaction } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync as replaceEntry } from "./session-accessor.js";
import {
  publishSessionEntryCacheInvalidation,
  readSessionEntryCache,
} from "./session-accessor.sqlite-entry-cache.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import type { InternalSessionEntry } from "./types.js";

it("publishes only committed durable entry changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:row-change" };
    const entry: InternalSessionEntry = { sessionId: "row-change", updatedAt: 1, label: "before" };
    replaceEntry(scope, entry);
    const options = { agentId: scope.agentId };
    const database = openOpenClawAgentDatabase(options);
    const snapshot = readSessionEntryCache(database, { cache: true });
    const prepared: Array<string | undefined> = [];
    const projections: SessionRowChange[] = [];
    const seen: Array<{
      change: SessionRowChange;
      label?: string;
      transaction: boolean;
      prepared: Array<string | undefined>;
    }> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      seen.push({
        change,
        label: snapshot.entries.get(scope.sessionKey)?.label,
        transaction: database.db.isTransaction,
        prepared: [...prepared],
      });
    });
    const stopProjection = sessionChanges.subscribeProjection((change) => {
      projections.push(change);
      prepared.push(snapshot.entries.get(scope.sessionKey)?.label);
    });
    const write = (label: string) => {
      replaceEntry(scope, { ...entry, label });
      expect({ seen, projections }).toEqual({ seen: [], projections: [] });
    };
    try {
      expect(() =>
        transaction(() => {
          write("rolled-back");
          throw new Error("rollback");
        }, options),
      ).toThrow("rollback");
      expect({ seen, prepared, projections }).toEqual({ seen: [], prepared: [], projections: [] });
      transaction(() => {
        write("intermediate");
        write("committed");
      }, options);
      expect(seen).toEqual(
        Array.from({ length: 2 }, () => ({
          change: { ...scope, storePath: database.path, scope: "session-entry" },
          label: "committed",
          transaction: false,
          prepared: ["committed", "committed"],
        })),
      );
      seen.length = 0;
      publishSessionEntryCacheInvalidation(database, { sessionKey: scope.sessionKey });
      expect(seen.map(({ change }) => change)).toEqual([{ ...scope, storePath: database.path }]);
      unsubscribe();
      replaceEntry(scope, entry);
      expect(seen).toHaveLength(1);
    } finally {
      unsubscribe();
      stopProjection();
    }
  });
});

it("publishes committed memory changes after projection without exposing private row facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-row-change",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    const owner = memorySessionActorOwners.get({ agentId: scope.agentId, path: scope.storePath });
    const authority = { assertCurrent() {}, authorize() {}, assertReadable() {} };
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: scope.sessionKey },
      authority,
    );
    const entry: InternalSessionEntry = {
      sessionId: "private-row-change",
      createdAt: 1,
      updatedAt: 1,
      label: "Private label must not enter lifetime facts",
      incognito: true,
    };
    const storage = actor.storage!;
    await expect(
      storage.mutate({ type: "session.entry.create", input: { entry } }, authority),
    ).resolves.toMatchObject({ kind: "committed" });
    const original = storage.readCurrent({ type: "session.entry.read", input: {} }, authority);
    const events: Array<["projection" | "observer", SessionRowChange]> = [];
    const stopProjection = sessionChanges.subscribeProjection((change) => {
      events.push(["projection", change]);
      expect(owner.readSession(scope.sessionKey, authority)?.entry?.updatedAt).toBe(2);
    });
    const unsubscribe = sessionChanges.subscribe((change) => events.push(["observer", change]));
    const write = (rollback: boolean) =>
      storage.mutate(
        {
          type: "session.entry.replace",
          input: { expected: original, entry: { ...original!, updatedAt: 2 } },
        },
        authority,
        {
          beforeCommit() {
            expect(events).toEqual([]);
            if (rollback) {
              throw new Error("rollback");
            }
          },
        },
      );
    try {
      await expect(write(true)).resolves.toMatchObject({
        kind: "rolled-back",
        error: { message: "rollback" },
      });
      expect(owner.readSession(scope.sessionKey, authority)?.entry?.updatedAt).toBe(1);
      expect(events).toEqual([]);
      await expect(write(false)).resolves.toMatchObject({ kind: "committed" });
      expect(events).toEqual([
        [
          "projection",
          {
            ...scope,
            facts: {
              kind: "replacement",
              communicationBinding:
                '["private-row-change",null,null,null,null,null,null,null,null,null,null,null]',
              membership: [scope.sessionKey, null, [], {}, entry.sessionId],
              lifecycleChanged: false,
            },
          },
        ],
        ["observer", scope],
      ]);
    } finally {
      unsubscribe();
      stopProjection();
      await actor.release();
      memorySessionActorOwners.closeDatabase(owner);
    }
  });
});

it.each(["delete", "retain-windows", "first-transcript"] as const)(
  "publishes only the changed key for a cold %s write after commit",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:cold-change" };
      replaceEntry(
        { ...scope, sessionKey: "agent:main:untouched-archive" },
        { sessionId: "untouched-archive", updatedAt: 1, archivedAt: 1 },
      );
      if (operation !== "first-transcript") {
        replaceEntry(scope, { sessionId: "cold-change", updatedAt: 1, archivedAt: 1 });
      }
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
      const changes: SessionRowChange[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
      try {
        transaction((writer) => {
          if (operation === "first-transcript") {
            ensureTranscriptSessionRoot(writer, { ...scope, sessionId: "cold-change" }, 2);
          } else {
            deleteSessionEntryRows(writer, scope.sessionKey, {
              deleteOwnedWindows: operation === "delete",
            });
          }
          expect(changes).toEqual([]);
        }, scope);
        expect(changes).toEqual([
          {
            ...scope,
            storePath: database.path,
            ...(operation !== "first-transcript" ? { scope: "session-entry" } : {}),
          },
        ]);
      } finally {
        unsubscribe();
      }
    });
  },
);

it("publishes committed registry changes while discarding a rolled-back agent removal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const target = { agentId: "main", path: database.path };
    const changes: SessionRowChange[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
    try {
      const mutations: Array<Parameters<typeof stateTransaction>[0]> = [
        () => registerOpenClawAgentDatabase(target),
        () => unregisterOpenClawAgentDatabase(target),
        () => unregisterOpenClawAgentDatabases({ agentId: "main" }),
        (state) => unregisterOpenClawAgentDatabases({ agentId: "main", database: state }),
      ];
      for (const mutate of mutations) {
        expect(() =>
          stateTransaction((state) => {
            mutate(state);
            expect(changes).toEqual([]);
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(changes).toEqual([]);
      }
      unregisterOpenClawAgentDatabase(target);
      registerOpenClawAgentDatabase(target);
      unregisterOpenClawAgentDatabases({ agentId: "main" });
      expect(changes).toEqual(
        Array.from({ length: 3 }, () => ({
          all: true,
          scope: { agentId: "main", topology: true },
        })),
      );
    } finally {
      unsubscribe();
    }
  });
});
