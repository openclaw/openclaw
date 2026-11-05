import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import * as mainThreadStall from "./main-thread-stall.js";
import { classifyGatewayStorageFailure } from "./sqlite-error-diagnostics.js";
import { receiveSqliteWorkerReply } from "./sqlite-worker-broker-reply.js";
import type { Actor, Job } from "./sqlite-worker-broker.types.js";
import type { SqliteWorkerCloseReceipt } from "./sqlite-worker-contract.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  isSqliteWorkerError,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
} from "./sqlite-worker-error.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

function unexpected() {
  throw new Error("Unexpected worker operation");
}

function createJob(request: Job["request"]): Job {
  return {
    custody: new SqliteWorkerSlotCustody().createRequest(),
    observation: { started() {}, completed() {} },
    request,
    bytes: 0,
    result: createDeferredCore().promise,
    resolve: unexpected,
    reject: unexpected,
    detach: unexpected,
  };
}

it("attributes synchronous reply decoding without creating an async task context", () => {
  let now = 0;
  const monitor = mainThreadStall.createMainThreadStallMonitor(() => (now += 300));
  const enterContext = vi.spyOn(AsyncLocalStorage.prototype, "run");
  const job = createJob({ type: "execute", id: 1, actor: 1, input: new Uint8Array() });
  const finish = vi.fn();
  try {
    receiveSqliteWorkerReply(
      { actors: new Set(), current: job, worker: { postMessage: unexpected } },
      { id: 1, ok: true, value: serialize({ count: 42 }) },
      { fail: unexpected, finish, dispatch() {} },
    );
    expect(finish).toHaveBeenCalledExactlyOnceWith(job, undefined, { count: 42 });
    expect(monitor.drain().stalls).toEqual([
      expect.objectContaining({ task: "worker:sqlite:reply-decode", elapsedMs: 300 }),
    ]);
    expect(enterContext).not.toHaveBeenCalled();
  } finally {
    enterContext.mockRestore();
    monitor.stop();
  }
});

it("settles ordinary replies without an additional wrapper crossing the decode boundary", () => {
  const decode = vi.spyOn(mainThreadStall, "runWithMainThreadTask");
  try {
    for (const value of [undefined, null, 42, { bytes: Buffer.from([0, 127, 255]), count: 42n }]) {
      const job = createJob({ type: "execute", id: 1, actor: 1, input: new Uint8Array() });
      const finish = vi.fn();
      receiveSqliteWorkerReply(
        { actors: new Set(), current: job, worker: { postMessage: unexpected } },
        { id: 1, ok: true, value: serialize(value) },
        { fail: unexpected, finish, dispatch() {} },
      );
      expect(finish).toHaveBeenCalledExactlyOnceWith(job, undefined, value);
      // Completion may return nothing or the decoded value itself, without an additional wrapper.
      const observed = decode.mock.results.at(-1)?.value;
      const delivered = finish.mock.calls[0]?.[2];
      expect(observed === undefined || Object.is(observed, delivered)).toBe(true);
    }
  } finally {
    decode.mockRestore();
  }
});

it.each(["framed", "close"])("publishes receipts before settling: %s", async (kind) => {
  const key = "openclaw.sqliteNativeRuntimeAdmission";
  const previous = getEnvironmentData(key);
  try {
    setEnvironmentData(key, undefined);
    vi.resetModules();
    const sqlite = await import("./node-sqlite.js");
    sqlite.requireNodeSqlite();
    const receipt: unknown = getEnvironmentData(key);
    assert(isRecord(receipt) && isRecord(receipt.runtime));
    setEnvironmentData(key, undefined);
    const nativeQueries = vi.spyOn(DatabaseSync.prototype, "prepare");
    const actor: Pick<Actor, "id" | "closeReceipt" | "openDispatch"> = {
      id: 1,
      openDispatch: { custody: new SqliteWorkerSlotCustody().createRequest() },
    };
    const closeReceipt: SqliteWorkerCloseReceipt = {
      identity: { key: "fixture", canonicalPath: "/fixture/state.sqlite" },
      incarnation: "closed-incarnation",
      checkpoint: {
        observedAtNs: 42n,
        health: {
          state: "complete",
          observedAtMs: 1,
          walBytes: 0,
          databaseBytes: 4096,
          logFrames: 0,
          checkpointedFrames: 0,
          lastCompletedAtMs: 1,
          consecutiveBlocked: 0,
          warning: false,
        },
      },
    };
    const job = createJob(
      kind === "close"
        ? { type: "close", id: 1, actor: 1 }
        : { type: "execute", id: 1, actor: 1, input: new Uint8Array() },
    );
    const finish = vi.fn(() => {
      expect(getEnvironmentData(key)).toEqual(receipt);
      if (kind === "close") {
        expect(actor.closeReceipt).toBe(closeReceipt);
      }
    });
    const postMessage = vi.fn();
    const slot = { actors: new Set([actor]), current: job, worker: { postMessage } };
    const owner = { fail: unexpected, finish, dispatch() {} };
    const receive = (value: unknown, transfer?: "start" | "frame") =>
      receiveSqliteWorkerReply(
        slot,
        {
          id: 1,
          ok: true,
          value: serialize(value),
          nativeRuntimeAdmission: receipt,
          ...(transfer ? { transfer } : {}),
          ...(kind === "close" ? { closeReceipt } : {}),
        },
        owner,
      );
    if (kind === "framed") {
      const producer = createSqliteWorkerTransferOwner();
      const handle = producer.start([{ kind: "result", value: "committed" }].values(), {
        kinds: ["result"],
      });
      receive(handle, "start");
      expect(getEnvironmentData(key)).toBeUndefined();
      let frame;
      do {
        frame = producer.next(handle.id);
        receive(frame, "frame");
        if (!frame.done) {
          expect(getEnvironmentData(key)).toBeUndefined();
          expect(finish).not.toHaveBeenCalled();
        }
      } while (!frame.done);
      producer.end(handle.id);
    } else {
      receive("committed");
      expect(postMessage).not.toHaveBeenCalled();
    }
    expect(finish).toHaveBeenCalledWith(job, undefined, "committed");
    expect(nativeQueries).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    setEnvironmentData(key, previous);
  }
});

it("hydrates cached-context execute-frame failures and their uncertain ordinary causes", () => {
  const primary = Object.assign(
    new Error("Synthetic preparation failure", { cause: new Error("Synthetic read failure") }),
    { code: "EIO", errno: -5 },
  );
  const original = retainSqliteWorkerErrorCode(
    new AggregateError([primary], "Synthetic cleanup failure", { cause: primary }),
    new SqliteWorkerError("Synthetic unknown write", "outcome-unknown"),
  );
  const sharedState = encodeOpenClawStateWorkerError(original, { includeOrdinary: true });
  assert(sharedState);
  const job = createJob({ type: "execute-frame", id: 1, actor: 1, input: new Uint8Array() });
  let failure: unknown;

  receiveSqliteWorkerReply(
    { actors: new Set(), current: job, worker: { postMessage: unexpected } },
    {
      id: 1,
      ok: false,
      error: {
        name: original.name,
        message: original.message,
        code: "outcome-unknown",
        sharedState: structuredClone(sharedState),
      },
    },
    {
      fail(error) {
        failure = error;
      },
      finish: unexpected,
      dispatch: unexpected,
    },
  );

  expect(failure).toBeInstanceOf(AggregateError);
  expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
  expect(classifyGatewayStorageFailure(failure)).toBe("session_actor_reconciliation");
  expect(isSqliteWorkerError(failure, "outcome-unknown")).toBe(false);
  expect(failure).toMatchObject({
    cause: {
      message: "Synthetic preparation failure",
      code: "EIO",
      errno: -5,
      cause: { message: "Synthetic read failure" },
    },
  });
});
