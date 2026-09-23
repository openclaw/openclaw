import { expect, it } from "vitest";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
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

it("publishes row changes after the complete entry transaction and discards rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:row-change" };
    const entry = { sessionId: "row-change", updatedAt: 1, label: "before" };
    replaceSessionEntrySync(scope, entry);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const snapshot = readSessionEntryCache(database, { cache: true });
    const prepared: Array<string | undefined> = [];
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
    const stopProjection = sessionChanges.subscribeProjection(() => {
      prepared.push(snapshot.entries.get(scope.sessionKey)?.label);
    });
    try {
      expect(() =>
        runOpenClawAgentWriteTransaction(
          () => {
            replaceSessionEntrySync(scope, { ...entry, label: "rolled-back" });
            expect(seen).toEqual([]);
            throw new Error("rollback");
          },
          { agentId: "main" },
        ),
      ).toThrow("rollback");
      expect(seen).toEqual([]);
      expect(prepared).toEqual([]);
      runOpenClawAgentWriteTransaction(
        () => {
          replaceSessionEntrySync(scope, { ...entry, label: "intermediate" });
          replaceSessionEntrySync(scope, { ...entry, label: "committed" });
          expect(seen).toEqual([]);
        },
        { agentId: "main" },
      );
      expect(seen).toEqual(
        Array.from({ length: 2 }, () => ({
          change: { ...scope, storePath: database.path },
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
        expect(changes).toEqual([{ ...scope, storePath: database.path }]);
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
      expect(changes).toEqual(Array.from({ length: 3 }, () => ({ all: true, scope: "stores" })));
    } finally {
      unsubscribe();
    }
  });
});
