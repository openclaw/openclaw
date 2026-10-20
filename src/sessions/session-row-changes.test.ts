import { afterEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { subscribeRuntimeSessionChanges } from "../plugins/runtime/session-changes.js";
import {
  captureSessionRowChanges,
  readSessionRowChangeRevision,
  sessionChanges,
  type SessionRowChange,
} from "./session-row-changes.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close();
  }
});

function database() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  cleanup.push(() => db.close());
  return db;
}

function collectKeys(keys: string[]) {
  return (change: SessionRowChange) => {
    if ("sessionKey" in change) {
      keys.push(change.sessionKey);
    }
  };
}

it("captures only surviving transaction postimages before the worker receipt is serialized", () => {
  const db = database();
  db.exec("CREATE TABLE facts (key TEXT PRIMARY KEY)");
  const write = (key: string) => {
    db.prepare("INSERT INTO facts VALUES (?)").run(key);
    sessionChanges.emit({ sessionKey: key, facts: { kind: "unchanged" } }, db);
  };
  const initialRevision = readSessionRowChangeRevision();
  const transaction = <T>(run: () => T) =>
    withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, run));
  const notifications: string[] = [];
  cleanup.push(sessionChanges.subscribe(collectKeys(notifications)));
  const receipt = transaction(() =>
    captureSessionRowChanges(db, () => {
      write("first");
      expect(() =>
        transaction(() => {
          write("rolled-back");
          throw new Error("cancel nested mutation");
        }),
      ).toThrow("cancel nested mutation");
      write("last");
      expect(notifications).toEqual([]);
      expect(readSessionRowChangeRevision()).toBe(initialRevision);
      return "committed";
    }),
  );
  expect(receipt.result).toBe("committed");
  expect(receipt.changes.map((change) => "sessionKey" in change && change.sessionKey)).toEqual([
    "first",
    "last",
  ]);
  expect(notifications).toEqual(["first", "last"]);
  expect(readSessionRowChangeRevision()).toBeGreaterThan(initialRevision);
  expect(db.prepare("SELECT key FROM facts ORDER BY key").all()).toEqual([
    { key: "first" },
    { key: "last" },
  ]);
});

it("keeps postcommit observer events outside the committing worker's captured postimages", () => {
  const db = database();
  const observed: string[] = [];
  cleanup.push(
    sessionChanges.subscribe((change) => {
      if (!("sessionKey" in change)) {
        return;
      }
      observed.push(change.sessionKey);
      if (change.sessionKey === "committed") {
        sessionChanges.emit({ sessionKey: "observer" }, db);
      }
    }),
  );
  const captured = captureSessionRowChanges(db, () =>
    withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () =>
        sessionChanges.emit({ sessionKey: "committed", facts: { kind: "unchanged" } }, db),
      ),
    ),
  );
  expect(observed).toEqual(["committed", "observer"]);
  expect(captured.changes).toEqual([{ sessionKey: "committed", facts: { kind: "unchanged" } }]);
});

it("settles session notifications through a connection's separate publication anchor", () => {
  const anchor = database();
  const db = Object.assign(database(), {
    anchor,
    [Symbol.for("openclaw.postgres-sync-connection")]: true,
  });
  const observed: string[] = [];
  cleanup.push(sessionChanges.subscribe(collectKeys(observed)));
  const emit = (sessionKey: string) =>
    sessionChanges.emit({ sessionKey, facts: { kind: "unchanged" } }, db);
  const captured = captureSessionRowChanges(anchor, () =>
    withSqlitePostCommitPublications(anchor, () => {
      expect(() =>
        withSqlitePostCommitPublications(anchor, () => {
          emit("rolled-back");
          throw new Error("cancel publication");
        }),
      ).toThrow("cancel publication");
      emit("committed");
      expect(observed).toEqual([]);
    }),
  );
  expect(captured.changes).toEqual([{ sessionKey: "committed", facts: { kind: "unchanged" } }]);
  expect(observed).toEqual(["committed"]);
});

it("installs private authority before observers without duplicate presentation notifications", () => {
  const installed: string[] = [];
  const projected: string[] = [];
  const observed: string[][] = [];
  const pluginEvents: string[] = [];
  const pluginFacts: string[][] = [];
  cleanup.push(
    sessionChanges.subscribeFacts(collectKeys(installed)),
    sessionChanges.subscribeProjection(collectKeys(projected)),
    sessionChanges.subscribe(() => observed.push([...installed])),
    subscribeRuntimeSessionChanges((change) => {
      pluginEvents.push(change.sessionKey);
      pluginFacts.push([...installed]);
    }),
  );
  sessionChanges.emitBatch([
    { agentId: "main", sessionKey: "entry", facts: { kind: "unchanged" } },
    sessionChanges.markFactsOnly({
      agentId: "main",
      sessionKey: "context",
      scope: "transcript",
      facts: { kind: "unchanged" },
    }),
  ]);
  expect(installed).toEqual(["entry", "context"]);
  expect(projected).toEqual(["entry"]);
  expect(observed).toEqual([["entry", "context"]]);
  expect(pluginEvents).toEqual(["entry"]);
  expect(pluginFacts).toEqual([["entry", "context"]]);
});
