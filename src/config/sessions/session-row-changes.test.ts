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

it("publishes row changes after the complete entry transaction and discards rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:row-change" };
    const entry = { sessionId: "row-change", updatedAt: 1, label: "before" };
    replaceSessionEntrySync(scope, entry);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const snapshot = readSessionEntryCache(database, { cache: true });
    const seen: Array<{ change: SessionRowChange; label?: string; transaction: boolean }> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      seen.push({
        change,
        label: snapshot.entries.get(scope.sessionKey)?.label,
        transaction: database.db.isTransaction,
      });
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
        })),
      );
      seen.length = 0;
      publishSessionEntryCacheInvalidation(database);
      expect(seen.map(({ change }) => change)).toEqual([
        { all: true, scope: { agentId: "main", storePath: database.path } },
      ]);
      unsubscribe();
      replaceSessionEntrySync(scope, entry);
      expect(seen).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});

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
