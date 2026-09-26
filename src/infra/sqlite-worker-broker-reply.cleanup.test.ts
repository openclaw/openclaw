import assert from "node:assert/strict";
import type { MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  settleSqliteWorkerJob,
  withSqliteWorkerCleanupFailure,
} from "./sqlite-worker-broker-reply.js";
import type { Job } from "./sqlite-worker-broker.types.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";

const effects = vi.hoisted(() => {
  const events: string[] = [];
  const warnings: unknown[] = [];
  const forbidden = vi.fn((): never => {
    throw new Error("Pure settlement proof crossed a native or unrelated effect boundary");
  });
  return { events, warnings, forbidden };
});

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: effects.forbidden,
  MessageChannel: effects.forbidden,
}));
vi.mock("node:sqlite", () => ({ DatabaseSync: effects.forbidden }));
vi.mock("node:child_process", () => ({
  spawn: effects.forbidden,
  spawnSync: effects.forbidden,
  exec: effects.forbidden,
  execSync: effects.forbidden,
  execFile: effects.forbidden,
  execFileSync: effects.forbidden,
  fork: effects.forbidden,
}));
vi.mock("../state/openclaw-state-worker-error.js", () => ({
  retainOpenClawStateWorkerErrorPayload: effects.forbidden,
}));
vi.mock("./sqlite-transaction.js", () => ({
  retainSqliteWriteAdmissionService: effects.forbidden,
}));
vi.mock("./sqlite-worker-transfer.js", () => ({
  createSqliteWorkerTransferOwner: effects.forbidden,
  createSqliteWorkerTransferReceiver: effects.forbidden,
}));

function jobWithCleanup(admissionFailures: readonly unknown[] = []) {
  const resolve = vi.fn((_value: unknown) => {
    effects.events.push("resolve");
  });
  const reject = vi.fn((_error: unknown) => {
    effects.events.push("reject");
  });
  const settleNative = vi.fn((_settlement: SqliteWorkerOperationSettlement) => {
    effects.events.push("settle-native");
  });
  const admission: SqliteWorkerOperationAdmission = {
    get port(): MessagePort {
      return effects.forbidden();
    },
    failure: undefined,
    failureSource: undefined,
    cleanupFailures: admissionFailures,
    committed: undefined,
    settlement: undefined,
    waitForSettlement: effects.forbidden,
    service: effects.forbidden,
    bindDatabaseAuthority: effects.forbidden,
    finish() {
      effects.events.push("finish-admission");
    },
  };
  const job: Job = {
    request: { type: "execute", id: 1, actor: 1, input: new Uint8Array() },
    bytes: 0,
    nativeDispatched: true,
    operationAdmission: {
      admission,
      releaseService() {
        effects.events.push("release-service");
      },
    },
    settleNative,
    resolve,
    reject,
    detach() {
      effects.events.push("detach");
    },
  };
  return { job, resolve, reject, settleNative };
}

function aggregate(value: unknown): AggregateError {
  assert(value instanceof AggregateError, "Expected the retained cleanup aggregate");
  return value;
}

function assertCleanupLineage(
  failure: unknown,
  original: Error,
  admissionFailures: readonly Error[],
) {
  const outer = aggregate(failure);
  expect(outer.cause).toBe(original);
  expect(outer.errors).toHaveLength(2);
  expect(outer.errors[0]).toBe(original);
  const admission = aggregate(outer.errors[1]);
  expect(admission.errors).toEqual(admissionFailures);
  return outer;
}

function cleanupFailures() {
  return [
    new Error("First admission cleanup failed"),
    new Error("Second admission cleanup failed"),
  ];
}

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
  it.each(["closed", "overloaded", "unavailable", "outcome-unknown"] as const)(
    "retains %s through admission cleanup failures",
    (code) => {
      const original = new SqliteWorkerError("Worker operation failed", code);
      const cleanup = cleanupFailures();
      const { job, resolve, reject, settleNative } = jobWithCleanup(cleanup);
      const settlement: SqliteWorkerOperationSettlement = { kind: "unknown", error: original };

      settleSqliteWorkerJob(job, original, undefined, settlement);

      expect(reject).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
      const outer = assertCleanupLineage(reject.mock.calls[0]?.[0], original, cleanup);
      expect(Object.getOwnPropertyDescriptor(outer, "code")?.value).toBe(code);
      expect(settleNative).toHaveBeenCalledExactlyOnceWith(settlement);
      expect(effects.events).toEqual([
        "settle-native",
        "finish-admission",
        "release-service",
        "detach",
        "reject",
      ]);
      expect(effects.warnings).toEqual([]);
    },
  );

  it.each(["plain code", "hostile code getter"] as const)(
    "does not classify an ordinary Error from its %s",
    (kind) => {
      const cleanup = cleanupFailures();
      const { job, resolve, reject } = jobWithCleanup(cleanup);
      const original = Object.assign(new Error("Ordinary worker error"), {
        name: "SqliteWorkerError",
        code: "outcome-unknown",
      });
      const getter = vi.fn((): never => {
        throw new Error("Ordinary Error.code must not be queried");
      });
      if (kind === "hostile code getter") {
        Object.defineProperty(original, "code", { get: getter, enumerable: true });
      }

      settleSqliteWorkerJob(job, original);

      expect(reject).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
      const outer = assertCleanupLineage(reject.mock.calls[0]?.[0], original, cleanup);
      expect("code" in outer).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("finishes settlement when an ordinary Error proxy refuses metadata descriptors", () => {
    const probeError = new Error("Error metadata descriptor access refused");
    const original = new Proxy(new Error("Ordinary proxied failure"), {
      getOwnPropertyDescriptor() {
        throw probeError;
      },
    });
    const cleanup = cleanupFailures();
    const { job, resolve, reject, settleNative } = jobWithCleanup(cleanup);

    settleSqliteWorkerJob(job, original);

    expect(reject.mock.calls.length).toBe(1);
    expect(resolve.mock.calls.length).toBe(0);
    const outer = assertCleanupLineage(reject.mock.calls[0]?.[0], original, cleanup);
    expect("code" in outer).toBe(false);
    expect(settleNative.mock.calls.length).toBe(1);
    expect(settleNative.mock.calls[0]?.[0].kind).toBe("completed");
    expect(Object.keys(settleNative.mock.calls[0]?.[0] ?? {})).toEqual(["kind"]);
    expect(effects.events).toEqual([
      "settle-native",
      "finish-admission",
      "release-service",
      "detach",
      "reject",
    ]);
    expect(effects.warnings.length).toBe(0);
  });

  it.each(["canonical error", "cleanup aggregate"] as const)(
    "retains a first-module %s through second-module settlement",
    async (kind) => {
      const original = new SqliteWorkerError("Original worker failure", "outcome-unknown");
      const earlierCleanup = new Error("Earlier owner cleanup failed");
      const failure =
        kind === "canonical error"
          ? original
          : withSqliteWorkerCleanupFailure(original, earlierCleanup);
      const getter = vi.fn((): never => {
        throw new Error("Helper aggregate.code must not be queried");
      });
      if (kind === "cleanup aggregate") {
        Object.defineProperty(failure, "code", { get: getter, enumerable: true });
      }
      vi.resetModules();
      const duplicate = await import("./sqlite-worker-broker-reply.js");
      const { SqliteWorkerError: DuplicateWorkerError } =
        await import("./sqlite-worker-contract.js");
      expect(duplicate.settleSqliteWorkerJob).not.toBe(settleSqliteWorkerJob);
      expect(original).not.toBeInstanceOf(DuplicateWorkerError);
      const cleanup = cleanupFailures();
      const { job, resolve, reject } = jobWithCleanup(cleanup);

      duplicate.settleSqliteWorkerJob(job, failure);

      expect(reject).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
      const outer = assertCleanupLineage(reject.mock.calls[0]?.[0], failure, cleanup);
      expect(Object.getOwnPropertyDescriptor(outer, "code")?.value).toBe("outcome-unknown");
      if (kind === "cleanup aggregate") {
        const first = aggregate(failure);
        expect(first.cause).toBe(original);
        expect(first.errors).toHaveLength(2);
        expect(first.errors[0]).toBe(original);
        expect(first.errors[1]).toBe(earlierCleanup);
      }
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([new Error("Ordinary failure"), new SqliteWorkerError("Worker failure", "closed")])(
    "preserves the original error identity when cleanup succeeds ($name)",
    (original) => {
      const { job, resolve, reject } = jobWithCleanup();

      settleSqliteWorkerJob(job, withSqliteWorkerCleanupFailure(original, undefined));

      expect(reject).toHaveBeenCalledExactlyOnceWith(original);
      expect(reject.mock.calls[0]?.[0]).toBe(original);
      expect(resolve).not.toHaveBeenCalled();
      expect(effects.warnings).toEqual([]);
    },
  );

  it("keeps a completed write successful while diagnosing admission cleanup failures", () => {
    const cleanup = cleanupFailures();
    const { job, resolve, reject, settleNative } = jobWithCleanup(cleanup);
    const committed = { revision: 42, rowsWritten: 1 };

    settleSqliteWorkerJob(job, undefined, committed);

    expect(resolve).toHaveBeenCalledExactlyOnceWith(committed);
    expect(resolve.mock.calls[0]?.[0]).toBe(committed);
    expect(reject).not.toHaveBeenCalled();
    expect(settleNative).toHaveBeenCalledExactlyOnceWith({ kind: "completed" });
    expect(effects.warnings).toHaveLength(1);
    const admissionWarning = aggregate(effects.warnings[0]);
    expect(admissionWarning.errors).toHaveLength(2);
    expect(admissionWarning.errors[0]).toBe(cleanup[0]);
    expect(admissionWarning.errors[1]).toBe(cleanup[1]);
    expect(effects.events).toEqual([
      "settle-native",
      "finish-admission",
      "release-service",
      "warning",
      "detach",
      "resolve",
    ]);
  });
});
