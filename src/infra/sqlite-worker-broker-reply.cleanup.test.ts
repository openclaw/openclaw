import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  failSqliteWorkerSlot,
  receiveSqliteWorkerReply,
  settleSqliteWorkerJob,
  withSqliteWorkerCleanupFailure,
} from "./sqlite-worker-broker-reply.js";
import type { Job } from "./sqlite-worker-broker.types.js";
import { hasSqliteWorkerOutcomeUnknown, SqliteWorkerError } from "./sqlite-worker-contract.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";

const effects = vi.hoisted(() => {
  const events: string[] = [];
  const warnings: unknown[] = [];
  const forbidden = vi.fn((): never => {
    throw new Error("Pure settlement proof crossed a native or unrelated effect boundary");
  });
  const forbid = (...names: string[]) => Object.fromEntries(names.map((name) => [name, forbidden]));
  return { events, warnings, forbidden, forbid };
});

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: effects.forbidden,
  MessageChannel: effects.forbidden,
}));
vi.mock("node:sqlite", () => ({ DatabaseSync: effects.forbidden }));
vi.mock("node:child_process", () =>
  effects.forbid("spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"),
);
// mock-isolation: Fail if pure reply settlement reaches unrelated native retention or transfer effects.
vi.mock("../state/openclaw-state-worker-error.js", () =>
  effects.forbid("retainOpenClawStateWorkerErrorPayload"),
);
// mock-isolation: Fail if pure reply settlement reaches unrelated native retention or transfer effects.
vi.mock("./sqlite-transaction.js", () => effects.forbid("retainSqliteWriteAdmissionService"));
// mock-isolation: Fail if pure reply settlement reaches unrelated native retention or transfer effects.
vi.mock("./sqlite-worker-transfer.js", () =>
  effects.forbid("createSqliteWorkerTransferOwner", "createSqliteWorkerTransferReceiver"),
);

function jobWithCleanup(admissionFailures: readonly unknown[] = [], dispatched = true) {
  const record = (event: string) => void effects.events.push(event);
  const slotCustody = new SqliteWorkerSlotCustody();
  const custody = slotCustody.createRequest();
  custody.activate();
  if (dispatched) {
    custody.accept();
  }
  const completion = createDeferredCore<unknown>();
  void completion.promise.catch(() => {});
  const track = (event: string, settle: (value: unknown) => void) =>
    vi.fn((value: unknown) => {
      record(event);
      settle(value);
    });
  const admission = {
    get port() {
      return effects.forbidden();
    },
    failure: undefined,
    failureSource: undefined,
    cleanupFailures: admissionFailures,
    committed: undefined,
    settlement: undefined,
    waitForSettlement: effects.forbidden,
    observeRequests: effects.forbidden,
    service: effects.forbidden,
    bindDatabaseAuthority: effects.forbidden,
    finish: () => record("finish-admission"),
  };
  const job = {
    custody,
    observation: { started() {}, completed() {} },
    request: { type: "execute", id: 1, actor: 1, input: new Uint8Array() },
    bytes: 0,
    result: completion.promise,
    operationAdmission: {
      admission,
      releaseService: () => record("release-service"),
    },
    settleNative: vi.fn((_settlement: SqliteWorkerOperationSettlement) => record("settle-native")),
    resolve: track("resolve", completion.resolve),
    reject: track("reject", completion.reject),
    detach: () => record("detach"),
  } satisfies Job;
  const slot: Parameters<typeof failSqliteWorkerSlot>[0] = {
    custody: slotCustody,
    current: job,
    queue: [],
    actors: new Set(),
  };
  const retirement = createDeferredCore();
  return {
    job,
    ...job,
    slot,
    fail(reason: unknown, completed?: Parameters<typeof failSqliteWorkerSlot>[2]["completed"]) {
      failSqliteWorkerSlot(slot, reason, {
        completed,
        retire: () => retirement.promise,
        finish: settleSqliteWorkerJob,
      });
    },
    async retire(retired: boolean, failure = new Error("Native retirement is still uncertain")) {
      if (retired) {
        retirement.resolve();
      } else {
        retirement.reject(failure);
      }
      await retirement.promise.catch(() => {});
    },
  };
}

function expectCalls(
  job: ReturnType<typeof jobWithCleanup>,
  calls: { resolve?: unknown[]; reject?: unknown[]; settleNative?: unknown[] } = {},
) {
  for (const method of ["resolve", "reject", "settleNative"] as const) {
    expect(job[method].mock.calls).toStrictEqual(calls[method]?.map((value) => [value]) ?? []);
  }
}

function expectEvents(outcome: "resolve" | "reject", warning = false) {
  expect(effects.events).toEqual([
    "settle-native",
    "finish-admission",
    "release-service",
    ...(warning ? ["warning"] : []),
    "detach",
    outcome,
  ]);
}

function aggregate(value: unknown, errors?: readonly unknown[]): AggregateError {
  assert(value instanceof AggregateError, "Expected the retained cleanup aggregate");
  if (errors) {
    expect(value.errors).toHaveLength(errors.length);
    errors.forEach((error, index) => expect(value.errors[index]).toBe(error));
  }
  return value;
}

function assertCleanupLineage(failure: unknown, original: Error) {
  const outer = aggregate(failure);
  expect(outer.cause).toBe(original);
  expect(outer.errors).toHaveLength(2);
  expect(outer.errors[0]).toBe(original);
  const admission = aggregate(outer.errors[1]);
  expect(admission.errors).toEqual(cleanup);
  return outer;
}

const cleanup = [new Error("First cleanup failed"), new Error("Second cleanup failed")];

beforeEach(() => {
  vi.clearAllMocks();
  effects.events.length = 0;
  effects.warnings.length = 0;
  vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
    effects.events.push("warning");
    effects.warnings.push(warning);
  });
});

afterEach(() => {
  try {
    expect(effects.forbidden).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe("SQLite worker settlement cleanup lineage", { concurrent: false }, () => {
  it("does not canonicalize an ordinary backend error with a public outcome code", () => {
    const { job } = jobWithCleanup();
    const finish = vi.fn();
    receiveSqliteWorkerReply(
      { current: job, actors: new Set(), worker: { postMessage: effects.forbidden } },
      {
        id: job.request.id,
        ok: false,
        error: { name: "Error", message: "Backend refused", code: "outcome-unknown" },
      },
      { fail: effects.forbidden, finish, dispatch: vi.fn() },
    );
    const failure: unknown = finish.mock.calls[0]?.[1];
    expect(failure).toMatchObject({ name: "Error", code: "outcome-unknown" });
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(false);
  });

  it.each([true, false])("keeps a lost outcome unknown after retirement: %s", async (retired) => {
    const current = jobWithCleanup();
    const error = new Error("Worker result was lost");
    current.fail(error);
    expect(current.settleNative).not.toHaveBeenCalled();
    await current.retire(retired);
    expect(current.settleNative).toHaveBeenCalledExactlyOnceWith({
      kind: "unknown",
      error,
      ...(retired ? { nativeStopped: true } : {}),
    });
    expect(current.resolve).not.toHaveBeenCalled();
    expect(current.reject).toHaveBeenCalledOnce();
  });
  it.each([
    { outcome: "value", retired: true },
    { outcome: "error", retired: false },
  ] as const)(
    "joins failed cleanup without losing $outcome (retired: $retired)",
    async ({ outcome, retired }) => {
      const current = jobWithCleanup();
      const queued = jobWithCleanup([], false);
      const value = { revision: 42 };
      const original = new Error("Original operation refused");
      const nativeCleanup = new Error("Native operation cleanup failed");
      const retirementFailure = new Error("Worker retirement could not be confirmed");
      const slot = current.slot;
      slot.queue.push(queued.job);
      current.fail(nativeCleanup, outcome === "value" ? { value } : { error: original });
      const queuedError = slot.failed;
      expect(queuedError).toMatchObject({ code: "unavailable", message: nativeCleanup.message });
      expectCalls(current);
      expect(queued.reject).not.toHaveBeenCalled();
      await current.retire(retired, retirementFailure);
      expectCalls(current, {
        settleNative: [
          retired ? { kind: "completed" } : { kind: "unknown", error: retirementFailure },
        ],
        ...(outcome === "value" ? { resolve: [value] } : { reject: [original] }),
      });
      expect(queued.resolve).not.toHaveBeenCalled();
      expect(queued.reject).toHaveBeenCalledExactlyOnceWith(
        retired ? queuedError : expect.objectContaining({ cause: queuedError }),
      );
      expect(effects.warnings).toEqual([
        expect.objectContaining({
          cause: retired ? nativeCleanup : expect.objectContaining({ cause: nativeCleanup }),
        }),
      ]);
    },
  );

  it("finishes settlement when an ordinary Error proxy refuses metadata descriptors", () => {
    const original = new Proxy(new Error("Ordinary proxied failure"), {
      getOwnPropertyDescriptor() {
        throw new Error("Error metadata descriptor access refused");
      },
    });
    const current = jobWithCleanup(cleanup);

    settleSqliteWorkerJob(current.job, original);

    const outer = assertCleanupLineage(current.reject.mock.calls[0]?.[0], original);
    expectCalls(current, { reject: [outer], settleNative: [{ kind: "completed" }] });
    expect("code" in outer).toBe(false);
    expectEvents("reject");
    expect(effects.warnings.length).toBe(0);
  });

  it("retains a first-module cleanup aggregate through second-module settlement", async () => {
    const original = new SqliteWorkerError("Original worker failure", "outcome-unknown");
    const earlierCleanup = new Error("Earlier owner cleanup failed");
    const failure = withSqliteWorkerCleanupFailure(original, earlierCleanup);
    Object.defineProperty(failure, "code", { get: effects.forbidden, enumerable: true });
    vi.resetModules();
    const duplicate = await import("./sqlite-worker-broker-reply.js");
    const { SqliteWorkerError: DuplicateWorkerError } = await import("./sqlite-worker-contract.js");
    expect(duplicate.settleSqliteWorkerJob).not.toBe(settleSqliteWorkerJob);
    expect(original).not.toBeInstanceOf(DuplicateWorkerError);
    const { job, resolve, reject } = jobWithCleanup(cleanup);

    duplicate.settleSqliteWorkerJob(job, failure);

    expect(reject).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    const outer = assertCleanupLineage(reject.mock.calls[0]?.[0], failure);
    expect(Object.getOwnPropertyDescriptor(outer, "code")?.value).toBe("outcome-unknown");
    expect(aggregate(failure, [original, earlierCleanup]).cause).toBe(original);
  });

  it("keeps a completed write successful while diagnosing admission cleanup failures", () => {
    const current = jobWithCleanup(cleanup);
    const committed = { revision: 42, rowsWritten: 1 };

    settleSqliteWorkerJob(current.job, undefined, committed);

    expectCalls(current, { resolve: [committed], settleNative: [{ kind: "completed" }] });
    expect(current.resolve.mock.calls[0]?.[0]).toBe(committed);
    expect(effects.warnings).toHaveLength(1);
    aggregate(effects.warnings[0], cleanup);
    expectEvents("resolve", true);
  });
});
