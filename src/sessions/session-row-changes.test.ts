import { expect, it, onTestFinished } from "vitest";
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

function database() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
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
  const write = (sessionKey: string) =>
    sessionChanges.emit({ sessionKey, facts: { kind: "unchanged" } }, db);
  const initialRevision = readSessionRowChangeRevision();
  const transaction = <T>(run: () => T) =>
    withSqlitePostCommitPublications(anchor, () =>
      separate ? run() : runSqliteImmediateTransactionSync(anchor, run),
    );
  const notifications: string[] = [];
  onTestFinished(
    sessionChanges.subscribe((change) => {
      collectKeys(notifications)(change);
      if ("sessionKey" in change && change.sessionKey === "last") {
        sessionChanges.emit({ sessionKey: "observer" }, db);
      }
    }),
  );
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
  const receipt = captureSessionRowChanges(anchor, () => transaction(mutate));
  expect(receipt.result).toBe("committed");
  expect(receipt.changes).toEqual(
    ["first", "last"].map((sessionKey) => ({ sessionKey, facts: { kind: "unchanged" } })),
  );
  expect(notifications).toEqual(["first", "last", "observer"]);
  expect(readSessionRowChangeRevision()).toBeGreaterThan(initialRevision);
});

it("installs private authority before observers without duplicate presentation notifications", () => {
  const installed: string[] = [];
  const projected: string[] = [];
  const observed: string[][] = [];
  const pluginEvents: string[] = [];
  const pluginFacts: string[][] = [];
  onTestFinished(sessionChanges.subscribeFacts(collectKeys(installed)));
  onTestFinished(sessionChanges.subscribeProjection(collectKeys(projected)));
  onTestFinished(sessionChanges.subscribe(() => observed.push([...installed])));
  onTestFinished(
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
