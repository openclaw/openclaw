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
import type { InternalSessionEntry } from "./types.js";

it.each([false, true])(
  "publishes only committed entry changes (incognito=%s)",
  async (incognito) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-row-change"
          : "agent:main:row-change",
        ...(incognito
          ? { storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }) }
          : {}),
      };
      const entry: InternalSessionEntry = incognito
        ? {
            sessionId: "private-row-change",
            createdAt: 1,
            updatedAt: 1,
            label: "Private label must not enter lifetime facts",
            incognito: true,
          }
        : { sessionId: "row-change", updatedAt: 1, label: "before" };
      replaceSessionEntrySync(scope, entry);
      const options = { agentId: scope.agentId, path: scope.storePath };
      const database = openOpenClawAgentDatabase(options);
      const snapshot = incognito ? undefined : readSessionEntryCache(database, { cache: true });
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
          label: snapshot?.entries.get(scope.sessionKey)?.label,
          transaction: database.db.isTransaction,
          prepared: [...prepared],
        });
      });
      const stopProjection = sessionChanges.subscribeProjection((change) => {
        projections.push(change);
        prepared.push(snapshot?.entries.get(scope.sessionKey)?.label);
      });
      const write = (label: string) => {
        replaceSessionEntrySync(
          scope,
          incognito ? { ...entry, updatedAt: 2 } : { ...entry, label },
        );
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
          if (!incognito) {
            write("intermediate");
          }
          write("committed");
        }, options);
        if (incognito) {
          expect(projections).toEqual([
            {
              ...scope,
              scope: "session-entry",
              facts: expect.objectContaining({ kind: "entry", sessionId: entry.sessionId }),
            },
          ]);
          expect(seen.map(({ change }) => change)).toEqual([{ ...scope, scope: "session-entry" }]);
        } else {
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
          expect(seen.map(({ change }) => change)).toEqual([
            { ...scope, storePath: database.path },
          ]);
          unsubscribe();
          replaceSessionEntrySync(scope, entry);
          expect(seen).toHaveLength(1);
        }
      } finally {
        unsubscribe();
        stopProjection();
      }
    });
  },
);

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
