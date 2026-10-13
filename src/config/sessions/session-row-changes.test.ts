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
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
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
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:row-change",
    };
    const entry: InternalSessionEntry = { sessionId: "row-change", updatedAt: 1, label: "before" };
    replaceSessionEntrySync(scope, entry);
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
      replaceSessionEntrySync(scope, { ...entry, label });
      expect(seen).toEqual([]);
      expect(projections).toEqual([]);
    };
    try {
      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          write("rolled-back");
          throw new Error("rollback");
        }, options),
      ).toThrow("rollback");
      expect(seen).toEqual([]);
      expect(prepared).toEqual([]);
      expect(projections).toEqual([]);
      runOpenClawAgentWriteTransaction(() => {
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
      replaceSessionEntrySync(scope, entry);
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
    const authority = { assertCurrent() {}, authorize() {} };
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: scope.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const entry: InternalSessionEntry = {
      sessionId: "private-row-change",
      createdAt: 1,
      updatedAt: 1,
      label: "Private label must not enter lifetime facts",
      incognito: true,
    };
    expect(
      await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    const original = actor.storage!.readCurrent(
      { type: "session.entry.read", input: {} },
      authority,
    );
    const order: string[] = [];
    const projections: SessionRowChange[] = [];
    const seen: SessionRowChange[] = [];
    const stopProjection = sessionChanges.subscribeProjection((change) => {
      projections.push(change);
      expect(owner.readSession(scope.sessionKey, authority)?.entry?.updatedAt).toBe(2);
      order.push("projection");
    });
    const unsubscribe = sessionChanges.subscribe((change) => {
      seen.push(change);
      order.push("observer");
    });
    const write = (rollback: boolean) =>
      actor.storage!.mutate(
        {
          type: "session.entry.replace",
          input: { expected: original, entry: { ...original!, updatedAt: 2 } },
        },
        authority,
        {
          beforeCommit() {
            expect(seen).toEqual([]);
            expect(projections).toEqual([]);
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
      expect(seen).toEqual([]);
      expect(projections).toEqual([]);
      await expect(write(false)).resolves.toMatchObject({ kind: "committed" });
      expect(projections).toEqual([
        {
          ...scope,
          facts: {
            kind: "replacement",
            communicationBinding:
              '["private-row-change",null,null,null,null,null,null,null,null,null,null,null]',
            membership: [
              scope.sessionKey,
              null,
              [],
              { participants: undefined, participantCount: undefined },
              entry.sessionId,
            ],
            lifecycleChanged: false,
          },
        },
      ]);
      expect(seen).toEqual([scope]);
      expect(order).toEqual(["projection", "observer"]);
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
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:untouched-archive" },
        { sessionId: "untouched-archive", updatedAt: 1, archivedAt: 1 },
      );
      if (operation !== "first-transcript") {
        replaceSessionEntrySync(scope, {
          sessionId: "cold-change",
          updatedAt: 1,
          archivedAt: 1,
        });
      }
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
      const changes: SessionRowChange[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
      try {
        runOpenClawAgentWriteTransaction((writer) => {
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
      for (const mutate of [
        () => registerOpenClawAgentDatabase(target),
        () => unregisterOpenClawAgentDatabase(target),
        () => unregisterOpenClawAgentDatabases({ agentId: "main" }),
      ]) {
        expect(() =>
          runOpenClawStateWriteTransaction(() => {
            mutate();
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(changes).toEqual([]);
      }
      expect(() =>
        runOpenClawStateWriteTransaction((state) => {
          unregisterOpenClawAgentDatabases({ agentId: "main", database: state });
          expect(changes).toEqual([]);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(changes).toEqual([]);
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
