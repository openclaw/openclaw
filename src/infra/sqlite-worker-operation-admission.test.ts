import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  createSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitReceipt,
  settleSqliteWorkerOperationContext,
  withSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-admission.js";

afterEach(() => vi.restoreAllMocks());

it("reads a queued worker commit before settlement and message callbacks run", async () => {
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const posted = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const posted = new Int32Array(workerData.posted);
    workerData.port.postMessage({ kind: "native-commit", committed: { facts: { count: 1 } } });
    Atomics.store(posted, 0, 1);
    Atomics.notify(posted, 0);
    Atomics.wait(posted, 1, 0, 10_000);
    workerData.port.postMessage({ kind: "native-settlement", settlement: {
      kind: "unknown", committed: { facts: { count: 1 } },
    } });
    workerData.port.close();
    Atomics.store(posted, 0, 2);
    Atomics.notify(posted, 0);
    parentPort.close();
  `,
    {
      eval: true,
      workerData: { port: admission.port, posted: posted.buffer },
      transferList: [admission.port],
    },
  );
  const joined = new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  try {
    if (Atomics.load(posted, 0) === 0) {
      Atomics.wait(posted, 0, 0, 10_000);
    }
    expect(Atomics.load(posted, 0)).toBe(1);
    expect(admission.settlement).toBeUndefined();
    expect(admission.committed).toEqual({ facts: { count: 1 } });
    expect(admission.settlement).toBeUndefined();
    Atomics.store(posted, 1, 1);
    Atomics.notify(posted, 1);
    if (Atomics.load(posted, 0) === 1) {
      Atomics.wait(posted, 0, 1, 10_000);
    }
    expect(Atomics.load(posted, 0)).toBe(2);
    expect(admission.settlement).toBeUndefined();
    admission.finish();
    expect(admission.committed).toEqual({ facts: { count: 1 } });
    expect(admission.settlement).toEqual({ kind: "unknown", committed: { facts: { count: 1 } } });
    expect(await joined).toBe(0);
  } finally {
    Atomics.store(posted, 1, 1);
    Atomics.notify(posted, 1);
    admission.finish();
    await worker.terminate();
  }
});

it.each(["commit", "rollback", "unknown", "later rollback", "later commit"] as const)(
  "keeps committed facts distinct from %s settlement",
  (outcome) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE proof (value INTEGER)");
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    const owner: SqliteWorkerOperationContext = { port: admission.port };
    try {
      const write = (value: number, rollback = false) =>
        withSqliteWorkerOperationAdmission(owner, () =>
          withSqlitePostCommitPublications(db, () =>
            runSqliteImmediateTransactionSync(db, () => {
              db.prepare("INSERT INTO proof VALUES (?)").run(value);
              deferSqliteWorkerCommitReceipt(db, { value });
              if (rollback) {
                throw new Error("Rollback the synthetic write");
              }
            }),
          ),
        );
      if (outcome === "rollback") {
        expect(() => write(1, true)).toThrow("Rollback the synthetic write");
      } else {
        write(1);
        if (outcome === "later rollback") {
          expect(() => write(2, true)).toThrow("Rollback the synthetic write");
        } else if (outcome === "later commit") {
          write(2);
        }
      }
      const committed =
        outcome === "rollback"
          ? undefined
          : { facts: { value: outcome === "later commit" ? 2 : 1 } };
      expect(admission.settlement).toBeUndefined();
      expect(admission.committed).toEqual(committed);
      expect(admission.settlement).toBeUndefined();
      expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
      settleSqliteWorkerOperationContext(owner, outcome === "unknown" ? "unknown" : "completed");
      if (outcome === "unknown") {
        expect(() => admission.waitForSettlement(performance.now())).toThrow(
          "settlement is unknown",
        );
        expect(admission.settlement).toEqual({
          kind: "unknown",
          committed: { facts: { value: 1 } },
        });
      } else {
        expect(admission.waitForSettlement(performance.now())).toEqual(
          committed ? { kind: "completed", committed } : { kind: "completed" },
        );
      }
      expect(db.prepare("SELECT value FROM proof ORDER BY value").all()).toEqual(
        outcome === "rollback"
          ? []
          : outcome === "later commit"
            ? [{ value: 1 }, { value: 2 }]
            : [{ value: 1 }],
      );
      admission.finish();
      expect(admission.committed).toEqual(committed);
      if (outcome === "commit") {
        expect(admission.waitForSettlement(performance.now()).committed?.facts).toEqual({
          value: 1,
        });
      }
    } finally {
      admission.finish();
      db.close();
    }
  },
);

it("does not treat a grant or a lost settlement message as a committed receipt", () => {
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  try {
    admission.port.postMessage(
      {
        stage: "transaction",
        facts: undefined,
        decision: decision.buffer,
      },
      [],
    );
    admission.service();
    expect(Atomics.load(decision, 0)).toBe(1);
    expect(admission.committed).toBeUndefined();
    expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
    expect(admission.settlement).toBeUndefined();
  } finally {
    admission.finish();
  }
});

it.each(["malformed", "after settlement"] as const)(
  "retains confirmed facts when a later commit receipt is %s",
  (receipt) => {
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    try {
      admission.port.postMessage({ kind: "native-commit", committed: { facts: { value: 1 } } }, []);
      if (receipt === "after settlement") {
        admission.port.postMessage(
          {
            kind: "native-settlement",
            settlement: { kind: "completed", committed: { facts: { value: 1 } } },
          },
          [],
        );
      }
      admission.port.postMessage(
        {
          kind: "native-commit",
          committed: receipt === "malformed" ? null : { facts: { value: 2 } },
        },
        [],
      );
      admission.finish();
      expect(admission.committed).toEqual({ facts: { value: 1 } });
      expect(admission.failure).toMatchObject({
        message: "SQLite worker commit receipt is invalid",
      });
      expect(() => admission.waitForSettlement(performance.now())).toThrow(
        "SQLite worker commit receipt is invalid",
      );
    } finally {
      admission.finish();
    }
  },
);

it("shares the active operation across module copies without mixing nested ports", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  expect(duplicate.withSqliteWorkerOperationAdmission).not.toBe(withSqliteWorkerOperationAdmission);
  const outer = new MessageChannel();
  const inner = new MessageChannel();
  // Only the carrier is under test here. Real cross-thread grants and revocation
  // are covered by the publication and public-runtime reclamation tests.
  const grant = (message: { decision: SharedArrayBuffer }) => {
    Atomics.store(new Int32Array(message.decision), 0, 1);
  };
  const outerRequests = vi.spyOn(outer.port1, "postMessage").mockImplementation(grant);
  const innerRequests = vi.spyOn(inner.port1, "postMessage").mockImplementation(grant);
  const request = (facts: string) =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
  try {
    withSqliteWorkerOperationAdmission({ port: outer.port1 }, () => {
      request("outer-before");
      duplicate.withSqliteWorkerOperationAdmission({ port: inner.port1 }, () => request("inner"));
      request("outer-after");
    });
    expect(outerRequests.mock.calls.map(([message]) => message.facts)).toEqual([
      "outer-before",
      "outer-after",
    ]);
    expect(innerRequests.mock.calls.map(([message]) => message.facts)).toEqual(["inner"]);
    expect(() => request("outside")).toThrow("requires its retained admission");
    expect(outerRequests).toHaveBeenCalledTimes(2);
    expect(innerRequests).toHaveBeenCalledTimes(1);
  } finally {
    outer.port1.close();
    outer.port2.close();
    inner.port1.close();
    inner.port2.close();
  }
});

it("refuses escaped continuations and captured scopes after synchronous operation exit", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  const { port1, port2 } = new MessageChannel();
  const requests = vi.spyOn(port1, "postMessage");
  const request = () =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
  try {
    const escaped = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      Promise.resolve().then(request),
    );
    await expect(escaped).rejects.toThrow("requires its retained admission");
    const captured = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      AsyncLocalStorage.snapshot(),
    );
    expect(() => captured(request)).toThrow("requires its retained admission");
    let failedScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    expect(() =>
      withSqliteWorkerOperationAdmission({ port: port1 }, () => {
        failedScope = AsyncLocalStorage.snapshot();
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(failedScope).toBeDefined();
    expect(() => failedScope?.(request)).toThrow("requires its retained admission");
    expect(requests).not.toHaveBeenCalled();
  } finally {
    port1.close();
    port2.close();
  }
});
