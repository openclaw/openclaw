import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  createSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  requestSqliteWorkerOperationAdmission,
  settleSqliteWorkerOperationContext,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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
              requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
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
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    now += 1_000_000_000n;
    expect(grant(beforeRelease)).toBe(false);
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  try {
    expect(() =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined }),
      ),
    ).toThrow(expect.objectContaining({ name: "SqliteWorkerAdmissionTimeoutError" }));
    expect(beforeRelease).not.toHaveBeenCalled();
    expect(admission.failure).toBeUndefined();
  } finally {
    admission.finish();
  }
});
