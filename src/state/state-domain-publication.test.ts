import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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

function domain(
  sourceIdentity?: (db: DatabaseSync) => string | symbol,
  name = `receipt-test-${randomUUID()}`,
) {
  return createStateDomainPublication<Row>({
    domain: name,
    sourceIdentity,
    keyOf: (row) => row.id,
    isValue: (value): value is Row =>
      isRecord(value) && typeof value.id === "string" && typeof value.version === "number",
  });
}

function observe(publication: ReturnType<typeof domain>) {
  const changes: StateDomainChange<Row>[] = [];
  cleanup.push(publication.subscribeFacts((change) => changes.push(change)));
  return changes;
}

const postimages = (...rows: Row[]) =>
  new Map(rows.map((value) => [value.id, { kind: "postimage", value }]));
const kinds = (changes: StateDomainChange<Row>[]) => changes.map(({ kind }) => kind);

function fixture(publishPending = true) {
  const db = openTrackedStateDatabase(
    path.join(dirs.make("state-domain-receipts-"), "state.sqlite"),
  );
  cleanup.push(() => db.close());
  db.exec("CREATE TABLE facts (id TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  const publication = domain();
  const transaction = <T>(write: () => T) =>
    withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, write));
  const capture = <T>(write: () => T, owner = publication) =>
    transaction(() => owner.capture(db, write));
  const write = (row: Row, owner = publication) => {
    db.prepare("INSERT OR REPLACE INTO facts VALUES (?, ?)").run(row.id, row.version);
    owner.stagePostimages(db, [row]);
  };
  const begin = (owner = publication) =>
    owner.begin({
      identity: readTrackedStateDatabaseIdentity(db)!.key,
      publishPending,
      assertCurrent() {
        if (!db.isOpen) {
          throw new Error("closed database");
        }
      },
    });
  return { db, publication, transaction, capture, write, begin };
}

it("publishes committed facts under the domain's admitted source identity", () => {
  const { capture, write } = fixture();
  const identity = "admitted-agent-database";
  const publication = domain(() => identity);
  const credential = { id: "credential", version: 2 };
  const captured = capture(() => write(credential, publication), publication);
  const changes = observe(publication);
  const pending = publication.begin({ identity, assertCurrent() {} });
  pending.committed(captured.receipt);
  pending.finish(true);
  const receipt = { source: { identity }, facts: postimages(credential) };
  expect(changes).toMatchObject([
    { kind: "pending", identity },
    { kind: "committed", receipt },
    { kind: "settled", identity },
  ]);
});

it("captures only committed postimages across nested rollback and waits for the outer commit", () => {
  const { db, publication, transaction, capture, write } = fixture();
  const changes = observe(publication);
  const captured = capture(() => {
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
  });
  expect(captured.receipt.facts).toEqual(
    postimages({ id: "kept", version: 1 }, { id: "sibling", version: 3 }),
  );
  expect(db.prepare("SELECT * FROM facts ORDER BY id").all()).toEqual([
    { id: "kept", version: 1 },
    { id: "sibling", version: 3 },
  ]);
  expect(changes).toHaveLength(2);
});

it("shares nested captures across facades for the same domain and database", () => {
  const { db, capture, write } = fixture();
  const name = `shared-receipt-test-${randomUUID()}`;
  const first = domain(undefined, name);
  const second = domain(undefined, name);
  const captured = capture(() => {
    write({ id: "before", version: 1 }, first);
    const nested = second.capture(db, () => write({ id: "nested", version: 2 }, second));
    expect([...nested.receipt.facts.keys()]).toEqual(["before", "nested"]);
    write({ id: "after", version: 3 }, first);
    return "written";
  }, first);
  expect(captured.result).toBe("written");
  expect([...captured.receipt.facts.keys()]).toEqual(["before", "nested", "after"]);
});

it.each([false, true])(
  "restores the outer database capture after a nested capture (throws=%s)",
  (throws) => {
    const outer = fixture();
    const inner = fixture();
    const publication = outer.publication;
    const captured = outer.capture(() => {
      outer.write({ id: "before", version: 1 });
      const runInner = () =>
        inner.capture(() => {
          inner.write({ id: "other-database", version: 2 }, publication);
          if (throws) {
            throw new Error("inner rollback");
          }
        }, publication);
      if (throws) {
        expect(runInner).toThrow("inner rollback");
      } else {
        expect([...runInner().receipt.facts.keys()]).toEqual(["other-database"]);
      }
      outer.write({ id: "after", version: 3 });
    });
    expect([...captured.receipt.facts.keys()]).toEqual(["before", "after"]);
    expect(inner.db.prepare("SELECT * FROM facts").all()).toEqual(
      throws ? [] : [{ id: "other-database", version: 2 }],
    );
    expect(publication.capture(outer.db, () => {}).receipt.facts.size).toBe(0);
  },
);

it("installs all worker domains when their shared publication batch completes", () => {
  const { db, publication, capture, write, begin } = fixture();
  const sibling = domain();
  const captured = capture(() =>
    sibling.capture(db, () => {
      write({ id: "approval", version: 1 });
      write({ id: "grant", version: 1 }, sibling);
    }),
  );
  const installed = new Set<string>();
  for (const owner of [publication, sibling]) {
    cleanup.push(
      owner.subscribeFacts((change) => {
        if (change.kind === "committed") {
          for (const key of change.receipt.facts.keys()) {
            installed.add(key);
          }
        }
      }),
    );
  }
  const first = begin();
  const second = begin(sibling);
  batchStateDomainPublications(() => {
    first.committed(captured.receipt);
    second.committed(captured.result.receipt);
    expect(installed.size).toBe(0);
  });
  first.finish(true);
  second.finish(true);
  expect([...installed].toSorted()).toEqual(["approval", "grant"]);
});

it.each([true, false])(
  "cannot restore a newer native deletion with a delayed worker receipt (pending=%s)",
  (publishPending) => {
    const { db, publication, transaction, capture, write, begin } = fixture(publishPending);
    const captured = capture(() => write({ id: "grant", version: 1 }));
    const delayed = begin();
    transaction(() => {
      db.prepare("DELETE FROM facts WHERE id = ?").run("grant");
      publication.stageDeletions(db, ["grant"]);
    });
    const observed = observe(publication);
    delayed.committed(captured.receipt);
    delayed.finish(true);
    expect(observed.filter((change) => change.kind === "committed")).toMatchObject([
      { kind: "committed", receipt: { facts: new Map([["grant", { kind: "unknown" }]]) } },
    ]);
    expect(db.prepare("SELECT * FROM facts").all()).toEqual([]);
  },
);

it.each([true, false])(
  "distinguishes a proven rollback from missing accepted commit evidence (pending=%s)",
  (publishPending) => {
    const { publication, begin } = fixture(publishPending);
    const changes = observe(publication);
    begin().finish(true, true);
    expect(kinds(changes)).toEqual(publishPending ? ["pending", "settled"] : []);
    changes.length = 0;
    begin().finish(true);
    expect(kinds(changes)).toEqual(
      publishPending ? ["pending", "unknown", "settled"] : ["unknown"],
    );
  },
);

it("invalidates installed facts when their publisher throws before completed settlement", () => {
  const { publication, capture, write, begin } = fixture();
  const captured = capture(() => write({ id: "grant", version: 1 }));
  const changes = observe(publication);
  const pending = begin();
  const failure = new Error("publication failed");
  expect(() =>
    pending.committed(captured.receipt, () => {
      throw failure;
    }),
  ).toThrow(failure);
  pending.finish(true);
  expect(kinds(changes)).toEqual(["pending", "committed", "unknown", "settled"]);
});
