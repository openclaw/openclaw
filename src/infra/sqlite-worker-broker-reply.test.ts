import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { receiveSqliteWorkerReply } from "./sqlite-worker-broker-reply.js";
import type { Actor, Job } from "./sqlite-worker-broker.types.js";
import type { SqliteWorkerCloseReceipt } from "./sqlite-worker-contract.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

it.each(["valid", "framed", "close", "mismatched", "unsafe", "malformed"])(
  "publishes worker receipts before settling its %s reply",
  async (kind) => {
    const key = "openclaw.sqliteNativeRuntimeAdmission";
    const previous = getEnvironmentData(key);
    try {
      setEnvironmentData(key, undefined);
      vi.resetModules();
      const sqlite = await import("./node-sqlite.js");
      sqlite.requireNodeSqlite();
      const receipt: unknown = getEnvironmentData(key);
      assert(isRecord(receipt) && isRecord(receipt.runtime));
      const forwarded =
        kind === "mismatched"
          ? { ...receipt, runtime: { ...receipt.runtime, pid: process.pid + 1 } }
          : kind === "unsafe"
            ? { ...receipt, version: "3.51.2" }
            : kind === "malformed"
              ? { ...receipt, extensionLoadingSupported: "yes" }
              : receipt;
      setEnvironmentData(key, undefined);
      const nativeQueries = vi.spyOn(DatabaseSync.prototype, "prepare");
      const unexpected = () => {
        throw new Error("Runtime admission must not add a request or fail the operation");
      };
      const actor: Pick<Actor, "id" | "closeReceipt"> = { id: 1 };
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
      const job: Job = {
        observation: { started() {}, completed() {} },
        request:
          kind === "close"
            ? { type: "close", id: 1, actor: 1 }
            : { type: "execute", id: 1, actor: 1, input: new Uint8Array() },
        bytes: 0,
        resolve: unexpected,
        reject: unexpected,
        detach: unexpected,
      };
      const finish = vi.fn(() => {
        expect(getEnvironmentData(key)).toEqual(
          kind === "valid" || kind === "framed" || kind === "close" ? receipt : undefined,
        );
        if (kind === "close") {
          expect(actor.closeReceipt).toMatchObject({
            incarnation: "closed-incarnation",
            checkpoint: { observedAtNs: 42n },
          });
        }
      });
      const postMessage = vi.fn();
      const slot = { actors: new Set([actor]), current: job, worker: { postMessage } };
      const owner = { fail: unexpected, finish, dispatch() {} };
      if (kind === "framed") {
        const producer = createSqliteWorkerTransferOwner();
        const handle = producer.start([{ kind: "result", value: "committed" }].values(), {
          kinds: ["result"],
        });
        receiveSqliteWorkerReply(
          slot,
          {
            id: 1,
            ok: true,
            value: serialize(handle),
            transfer: "start",
            nativeRuntimeAdmission: forwarded,
          },
          owner,
        );
        expect(getEnvironmentData(key)).toBeUndefined();
        let frame;
        do {
          frame = producer.next(handle.id);
          receiveSqliteWorkerReply(
            slot,
            {
              id: 1,
              ok: true,
              value: serialize(frame),
              transfer: "frame",
              nativeRuntimeAdmission: forwarded,
            },
            owner,
          );
          if (!frame.done) {
            expect(getEnvironmentData(key)).toBeUndefined();
            expect(finish).not.toHaveBeenCalled();
          }
        } while (!frame.done);
        producer.end(handle.id);
        expect(postMessage).toHaveBeenCalledTimes(2);
      } else {
        receiveSqliteWorkerReply(
          slot,
          {
            id: 1,
            ok: true,
            value: serialize("committed"),
            nativeRuntimeAdmission: forwarded,
            ...(kind === "close" ? { closeReceipt } : {}),
          },
          owner,
        );
        expect(postMessage).not.toHaveBeenCalled();
      }
      expect(finish).toHaveBeenCalledWith(job, undefined, "committed");
      expect(nativeQueries).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      setEnvironmentData(key, previous);
    }
  },
);

it("hydrates cached-context execute-frame errors without an explicit request context", () => {
  const original = Object.assign(
    new Error("Synthetic preparation failure", { cause: new Error("Synthetic read failure") }),
    { code: "EIO", errno: -5 },
  );
  const sharedState = encodeOpenClawStateWorkerError(original, { includeOrdinary: true });
  assert(sharedState);
  const unexpected = () => {
    throw new Error("Failed continuation must not dispatch or finish successfully");
  };
  const job: Job = {
    observation: { started() {}, completed() {} },
    request: { type: "execute-frame", id: 1, actor: 1, input: new Uint8Array() },
    bytes: 0,
    resolve: unexpected,
    reject: unexpected,
    detach: unexpected,
  };
  let failure: unknown;

  receiveSqliteWorkerReply(
    { actors: new Set(), current: job, worker: { postMessage: unexpected } },
    {
      id: 1,
      ok: false,
      error: {
        name: "Error",
        message: "Synthetic preparation failure",
        code: "EIO",
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

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: "Synthetic preparation failure",
    code: "EIO",
    errno: -5,
    cause: { message: "Synthetic read failure" },
  });
});
