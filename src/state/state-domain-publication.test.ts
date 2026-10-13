import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  openTrackedStateDatabase,
  readTrackedStateDatabaseIdentity,
} from "./openclaw-state-db-handle.js";
import {
  batchStateDomainPublications,
  createStateDomainPublication,
  type StateDomainChange,
} from "./state-domain-publication.js";

type Row = { id: string; version: number };
const dirs = useAutoCleanupTempDirTracker(afterEach);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close();
  }
});

function domain() {
  return createStateDomainPublication<Row>({
    domain: `receipt-test-${randomUUID()}`,
    keyOf: (row) => row.id,
    isValue: (value): value is Row =>
      isRecord(value) && typeof value.id === "string" && typeof value.version === "number",
  });
}

function fixture() {
  const db = openTrackedStateDatabase(
    path.join(dirs.make("state-domain-receipts-"), "state.sqlite"),
  );
  cleanup.push(() => db.close());
  db.exec("CREATE TABLE facts (id TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  const publication = domain();
  const transaction = <T>(write: () => T) =>
    withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, write));
  const write = (row: Row, owner = publication) => {
    db.prepare("INSERT OR REPLACE INTO facts VALUES (?, ?)").run(row.id, row.version);
    owner.stagePostimages(db, [row]);
  };
  const begin = (owner = publication) =>
    owner.begin({
      identity: readTrackedStateDatabaseIdentity(db)!.key,
      assertCurrent() {
        if (!db.isOpen) {
          throw new Error("closed database");
        }
      },
    });
  return { db, publication, transaction, write, begin };
}

it("captures only committed postimages across nested rollback and waits for the outer commit", () => {
  const { db, publication, transaction, write } = fixture();
  const changes: StateDomainChange<Row>[] = [];
  cleanup.push(publication.subscribe((change) => changes.push(change)));
  const captured = transaction(() =>
    publication.capture(db, () => {
      write({ id: "kept", version: 1 });
      expect(() =>
        transaction(() => {
          write({ id: "kept", version: 2 });
          write({ id: "discarded", version: 1 });
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      transaction(() => write({ id: "sibling", version: 3 }));
      expect(changes).toEqual([]);
    }),
  );
  expect(captured.receipt.facts).toEqual(
    new Map([
      ["kept", { kind: "postimage", value: { id: "kept", version: 1 } }],
      ["sibling", { kind: "postimage", value: { id: "sibling", version: 3 } }],
    ]),
  );
  expect(db.prepare("SELECT * FROM facts ORDER BY id").all()).toEqual([
    { id: "kept", version: 1 },
    { id: "sibling", version: 3 },
  ]);
  expect(changes).toHaveLength(2);
});

it("installs all domains from a worker commit before notifying either domain", () => {
  const { db, publication, transaction, write, begin } = fixture();
  const sibling = domain();
  const captured = transaction(() =>
    publication.capture(db, () =>
      sibling.capture(db, () => {
        write({ id: "approval", version: 1 });
        write({ id: "grant", version: 1 }, sibling);
      }),
    ),
  );
  const installed = new Set<string>();
  const observations: string[][] = [];
  for (const owner of [publication, sibling]) {
    cleanup.push(
      owner.subscribeFacts((change) => {
        if (change.kind === "committed") {
          for (const key of change.receipt.facts.keys()) {
            installed.add(key);
          }
        }
      }),
      owner.subscribe(() => observations.push([...installed].toSorted())),
    );
  }
  const first = begin();
  const second = begin(sibling);
  batchStateDomainPublications(() => {
    first.committed(captured.receipt);
    second.committed(captured.result.receipt);
  });
  first.finish(true);
  second.finish(true);
  expect(observations).toEqual([
    ["approval", "grant"],
    ["approval", "grant"],
  ]);
});

it("cannot restore a newer native deletion with a delayed worker receipt", () => {
  const { db, publication, transaction, write, begin } = fixture();
  const captured = transaction(() =>
    publication.capture(db, () => write({ id: "grant", version: 1 })),
  );
  const delayed = begin();
  transaction(() => {
    db.prepare("DELETE FROM facts WHERE id = ?").run("grant");
    publication.stageDeletions(db, ["grant"]);
  });
  const observed: StateDomainChange<Row>[] = [];
  cleanup.push(publication.subscribe((change) => observed.push(change)));
  delayed.committed(captured.receipt);
  delayed.finish(true);
  expect(observed).toMatchObject([
    { kind: "committed", receipt: { facts: new Map([["grant", { kind: "unknown" }]]) } },
  ]);
  expect(db.prepare("SELECT * FROM facts").all()).toEqual([]);
});

it("distinguishes a proven rollback from missing accepted commit evidence", () => {
  const { publication, begin } = fixture();
  const changes: StateDomainChange<Row>[] = [];
  cleanup.push(publication.subscribeFacts((change) => changes.push(change)));
  begin().finish(true, true);
  expect(changes.map((change) => change.kind)).toEqual(["pending", "settled"]);
  changes.length = 0;
  begin().finish(true);
  expect(changes.map((change) => change.kind)).toEqual(["pending", "unknown", "settled"]);
});

it("invalidates installed facts when their publisher throws before completed settlement", () => {
  const { db, publication, transaction, write, begin } = fixture();
  const captured = transaction(() =>
    publication.capture(db, () => write({ id: "grant", version: 1 })),
  );
  const changes: StateDomainChange<Row>[] = [];
  cleanup.push(publication.subscribeFacts((change) => changes.push(change)));
  const pending = begin();
  const failure = new Error("publication failed");
  expect(() =>
    pending.committed(captured.receipt, () => {
      throw failure;
    }),
  ).toThrow(failure);
  pending.finish(true);
  expect(changes.map((change) => change.kind)).toEqual([
    "pending",
    "committed",
    "unknown",
    "settled",
  ]);
});
