import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  createSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { settleSqliteWorkerOperationContext } from "./sqlite-worker-operation-settlement.js";
import type { SqliteWorkerOperationContext } from "./sqlite-worker-operation-settlement.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function admissionFixture(
  admit: Parameters<typeof createSqliteWorkerOperationAdmission>[0] = vi.fn((_request, grant) =>
    grant(),
  ),
) {
  const admission = createSqliteWorkerOperationAdmission(admit);
  onTestFinished(() => admission.finish());
  const request = (stage: "transaction" | "commit") =>
    withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined, deadlineMs: 1_000 }),
    );
  return { admission, admit, request };
}
function writerFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE proof (value INTEGER)");
  const { admission, admit } = admissionFixture();
  const owner: SqliteWorkerOperationContext = { port: admission.port };
  onTestFinished(() => {
    admission.finish();
    database.close();
  });
  const write = (request: () => void) =>
    withSqliteWorkerOperationAdmission(owner, () =>
      runSqliteImmediateTransactionSync(database, () => {
        database.exec("INSERT INTO proof VALUES (1)");
        request();
      }),
    );
  return { database, admission, admit, owner, write };
}

it("rolls back when broker custody is revoked after the host grant but before native use", () => {
  const { database, admission, admit, owner, write } = writerFixture();
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  custody.accept();
  owner.requestCustody = custody.descriptor;
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    custody.retire();
    return "ok";
  });
  expect(() =>
    write(() => requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined })),
  ).toThrow("request custody is revoked");
  expect(admit).toHaveBeenCalledOnce();
  expect(database.prepare("SELECT * FROM proof").all()).toEqual([]);
});

it.each(["transaction", "commit"] as const)(
  "keeps a non-cron $stage write waiting past one second without an explicit deadline",
  (stage) => {
    const { database, admission, admit, write } = writerFixture();
    let now = process.hrtime.bigint();
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
    const wait = vi
      .spyOn(Atomics, "wait")
      .mockImplementationOnce(() => {
        now += 2_000_000_000n;
        return "timed-out";
      })
      .mockImplementationOnce(() => {
        admission.service();
        return "ok";
      });
    write(() => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }));
    expect(wait).toHaveBeenCalledTimes(2);
    expect(admit).toHaveBeenCalledOnce();
    expect(admission.failure).toBeUndefined();
    expect(database.prepare("SELECT value FROM proof").all()).toEqual([{ value: 1 }]);
  },
);

it.each([
  { stage: "transaction", priorCommit: false },
  { stage: "commit", priorCommit: false },
  { stage: "commit", priorCommit: true },
] as const)(
  "rolls back delayed $stage admission and retains prior commits ($priorCommit)",
  ({ stage, priorCommit }) => {
    const filename = path.join(tempDirs.make("sqlite-admission-timeout-"), "proof.sqlite");
    const writer = new DatabaseSync(filename);
    const competitor = new DatabaseSync(filename);
    writer.exec("CREATE TABLE proof (value INTEGER)");
    competitor.exec("PRAGMA busy_timeout = 0");
    const admit = vi.fn((_request, grant: () => boolean) => grant());
    const admission = createSqliteWorkerOperationAdmission(admit);
    const owner = { port: admission.port };
    const publish = vi.fn();
    observeSqliteWorkerCommittedFacts(admission, publish);
    let now = process.hrtime.bigint();
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
    const wait = vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
      expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
      // Advance only the admission clock; SQL and rollback use the real connections.
      now += 1_000_000_000n;
      if (timeout === undefined) {
        // The pre-fix unbounded waiter accepts this late grant and commits instead of rolling back.
        admission.service();
      }
      return "timed-out";
    });
    const write = (value: number, requestAdmission = true) =>
      withSqliteWorkerOperationAdmission(owner, () =>
        withSqlitePostCommitPublications(writer, () =>
          runSqliteImmediateTransactionSync(writer, () => {
            writer.prepare("INSERT INTO proof VALUES (?)").run(value);
            deferSqliteWorkerCommitReceipt(writer, { value });
            if (requestAdmission) {
              requestSqliteWorkerOperationAdmission({ stage, facts: undefined, deadlineMs: 1_000 });
            }
          }),
        ),
      );
    try {
      if (priorCommit) {
        write(0, false);
      }
      expect(() => write(1)).toThrow(
        expect.objectContaining({
          name: "SqliteWorkerAdmissionTimeoutError",
          code: "admission-timeout",
        }),
      );
      expect(wait).toHaveBeenCalledOnce();
      expect(wait.mock.calls[0]?.[3]).toBe(1_000);
      competitor.exec("BEGIN IMMEDIATE; COMMIT");
      expect(competitor.prepare("SELECT * FROM proof").all()).toEqual(
        priorCommit ? [{ value: 0 }] : [],
      );
      admission.service();
      expect(admit).not.toHaveBeenCalled();
      expect(publish.mock.calls).toEqual(priorCommit ? [[{ facts: { value: 0 } }]] : []);
      expect(admission.failure).toBeUndefined();
      settleSqliteWorkerOperationContext(owner, "completed");
      expect(admission.waitForSettlement(performance.now())).toEqual(
        priorCommit
          ? { kind: "completed", committed: { facts: { value: 0 } } }
          : { kind: "completed" },
      );
    } finally {
      admission.finish();
      competitor.close();
      writer.close();
    }
  },
);

it("refuses a host grant whose policy preparation crosses the deadline", () => {
  let now = process.hrtime.bigint();
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const beforeRelease = vi.fn();
  const { admission, request } = admissionFixture((_request, grant) => {
    now += 1_000_000_000n;
    expect(grant(beforeRelease)).toBe(false);
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });

  expect(() => request("commit")).toThrow(
    expect.objectContaining({ name: "SqliteWorkerAdmissionTimeoutError" }),
  );
  expect(beforeRelease).not.toHaveBeenCalled();
  expect(admission.failure).toBeUndefined();
});

it.each(["fake timers", "thread origin"] as const)(
  "grants across a host clock skew from %s",
  (clock) => {
    let now = process.hrtime.bigint();
    const aheadOfRealClockMs = Number(now / 1_000_000n) + 60_000;
    if (clock === "thread origin") {
      // Bun's per-thread origin puts a later worker behind its host.
      vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
    }
    const { admission, admit, request } = admissionFixture();
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      if (clock === "fake timers") {
        vi.useFakeTimers();
        vi.advanceTimersByTime(aheadOfRealClockMs);
      } else {
        now += 60_000_000_000n;
      }
      admission.service();
      return "ok";
    });
    try {
      request(clock === "fake timers" ? "commit" : "transaction");
      expect(admit).toHaveBeenCalledOnce();
      expect(admission.failure).toBeUndefined();
    } finally {
      vi.useRealTimers();
      admission.finish();
    }
  },
);
