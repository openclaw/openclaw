import { afterEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { subscribeRuntimeSessionChanges } from "../plugins/runtime/session-changes.js";
import { captureSessionRowChanges, sessionChanges } from "./session-row-changes.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close();
  }
});

it("captures only surviving transaction postimages before the worker receipt is serialized", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(":memory:");
  cleanup.push(() => database.close());
  database.exec("CREATE TABLE facts (key TEXT PRIMARY KEY)");
  const write = (key: string) => {
    database.prepare("INSERT INTO facts VALUES (?)").run(key);
    sessionChanges.emit({ sessionKey: key, facts: { kind: "unchanged" } }, database);
  };
  const transaction = <T>(run: () => T) =>
    withSqlitePostCommitPublications(database, () =>
      runSqliteImmediateTransactionSync(database, run),
    );
  const notifications: string[] = [];
  cleanup.push(
    sessionChanges.subscribe((change) => {
      if ("sessionKey" in change) {
        notifications.push(change.sessionKey);
      }
    }),
  );
  const receipt = transaction(() =>
    captureSessionRowChanges(database, () => {
      write("first");
      expect(() =>
        transaction(() => {
          write("rolled-back");
          throw new Error("cancel nested mutation");
        }),
      ).toThrow("cancel nested mutation");
      write("last");
      expect(notifications).toEqual([]);
      return "committed";
    }),
  );
  expect(receipt.result).toBe("committed");
  expect(receipt.changes.map((change) => "sessionKey" in change && change.sessionKey)).toEqual([
    "first",
    "last",
  ]);
  expect(notifications).toEqual(["first", "last"]);
  expect(database.prepare("SELECT key FROM facts ORDER BY key").all()).toEqual([
    { key: "first" },
    { key: "last" },
  ]);
});

it("keeps postcommit observer events outside the committing worker's captured postimages", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(":memory:");
  cleanup.push(() => database.close());
  const observed: string[] = [];
  cleanup.push(
    sessionChanges.subscribe((change) => {
      if (!("sessionKey" in change)) {
        return;
      }
      observed.push(change.sessionKey);
      if (change.sessionKey === "committed") {
        sessionChanges.emit({ sessionKey: "observer" }, database);
      }
    }),
  );
  const captured = captureSessionRowChanges(database, () =>
    withSqlitePostCommitPublications(database, () =>
      runSqliteImmediateTransactionSync(database, () =>
        sessionChanges.emit({ sessionKey: "committed", facts: { kind: "unchanged" } }, database),
      ),
    ),
  );
  expect(observed).toEqual(["committed", "observer"]);
  expect(captured.changes).toEqual([{ sessionKey: "committed", facts: { kind: "unchanged" } }]);
});

it("installs private authority before observers without duplicate presentation notifications", () => {
  const installed: string[] = [];
  const projected: string[] = [];
  const observed: string[][] = [];
  const pluginEvents: string[] = [];
  const pluginFacts: string[][] = [];
  cleanup.push(
    sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change) {
        installed.push(change.sessionKey);
      }
    }),
    sessionChanges.subscribeProjection((change) => {
      if ("sessionKey" in change) {
        projected.push(change.sessionKey);
      }
    }),
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
