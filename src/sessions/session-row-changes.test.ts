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

it.each([false, true])("captures surviving postimages with a separate anchor: %s", (separate) => {
  const anchor = database();
  const db = separate
    ? Object.assign(database(), { anchor, [Symbol.for("openclaw.postgres-sync-connection")]: true })
    : anchor;
  anchor.exec("CREATE TABLE facts (key TEXT PRIMARY KEY)");
  const write = (key: string) => {
    if (!separate) {
      anchor.prepare("INSERT INTO facts VALUES (?)").run(key);
    }
    sessionChanges.emit({ sessionKey: key, facts: { kind: "unchanged" } }, db);
  };
  const initialRevision = readSessionRowChangeRevision();
  const transaction = <T>(run: () => T) =>
    withSqlitePostCommitPublications(anchor, () =>
      separate ? run() : runSqliteImmediateTransactionSync(anchor, run),
    );
  const notifications: string[] = [];
  cleanup.push(sessionChanges.subscribe(collectKeys(notifications)));
  const mutate = () => {
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
  };
  const receipt = separate
    ? captureSessionRowChanges(anchor, () => transaction(mutate))
    : transaction(() => captureSessionRowChanges(anchor, mutate));
  expect(receipt.result).toBe("committed");
  expect(receipt.changes).toEqual(
    ["first", "last"].map((sessionKey) => ({ sessionKey, facts: { kind: "unchanged" } })),
  );
  expect(notifications).toEqual(["first", "last"]);
  expect(readSessionRowChangeRevision()).toBeGreaterThan(initialRevision);
  if (!separate) {
    expect(anchor.prepare("SELECT key FROM facts ORDER BY key").all()).toEqual(
      ["first", "last"].map((key) => ({ key })),
    );
  }
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
