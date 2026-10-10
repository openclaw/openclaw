import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitInput,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-ledger.js";

const SUCCESS_OUTCOME: WorkerTranscriptCommitOutcome = {
  ok: true,
  result: { entryIds: ["entry-a", "entry-b"], newLeafId: "entry-b" },
};
const ERROR_OUTCOME: WorkerTranscriptCommitOutcome = {
  ok: false,
  reason: "stale-base-leaf",
};
const BASE_INPUT: WorkerTranscriptCommitInput = {
  environmentId: "worker-a",
  sessionId: "session-a",
  runEpoch: 4,
  seq: 1,
  requestHash: "a".repeat(64),
};

describe("worker transcript commit store", () => {
  let root: string;
  let nowMs: number;
  let store: WorkerTranscriptCommitStore;
  let input: WorkerTranscriptCommitInput;
  let sequence = 0;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await closeStateDatabaseForTest();
      cleanup();
    }),
  );

  beforeAll(() => {
    root = tempDirs.make("openclaw-worker-commit-");
    nowMs = 1_000;
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerTranscriptCommitStore({ database, now: () => nowMs });
  });

  beforeEach(() => {
    input = { ...BASE_INPUT, sessionId: `session-${++sequence}` };
    nowMs = 1_000;
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs begin, completion, replay and exact discard without caller-thread SQL", async () => {
    const queries = observeHostDataSql();
    try {
      expect(await store.begin(input)).toEqual({ kind: "claimed" });
      expect(await store.complete({ ...input, outcome: SUCCESS_OUTCOME })).toEqual(SUCCESS_OUTCOME);
      expect(await store.begin(input)).toEqual({ kind: "replay", outcome: SUCCESS_OUTCOME });
      const next = { ...input, seq: 2 };
      expect(await store.begin(next)).toEqual({ kind: "claimed" });
      await store.discardUncommitted(next);
      expect(await store.begin(next)).toEqual({ kind: "claimed" });
      expect(queries.queries).toEqual([]);
    } finally {
      queries.restore();
    }
  });

  it("recovers pending work and replays a terminal result across reopen", async () => {
    expect(await store.begin(input)).toEqual({ kind: "claimed" });
    expect(await store.begin(input)).toEqual({ kind: "recover" });

    nowMs = 1_010;
    expect(await store.complete({ ...input, outcome: SUCCESS_OUTCOME })).toEqual(SUCCESS_OUTCOME);
    expect(await store.begin(input)).toEqual({ kind: "replay", outcome: SUCCESS_OUTCOME });

    await closeStateDatabaseForTest();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerTranscriptCommitStore({ database, now: () => nowMs });
    expect(await store.begin(input)).toEqual({ kind: "replay", outcome: SUCCESS_OUTCOME });
  });

  it("rejects a tuple replayed with a different payload or environment", async () => {
    expect(await store.begin(input)).toEqual({ kind: "claimed" });
    expect(await store.begin({ ...input, requestHash: "b".repeat(64) })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
    await store.complete({ ...input, outcome: SUCCESS_OUTCOME });
    expect(await store.begin({ ...input, requestHash: "b".repeat(64) })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
    expect(await store.begin({ ...input, environmentId: "worker-b" })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
  });

  it("advances one ordered sequence only after terminal completion", async () => {
    const second = { ...input, seq: 2, requestHash: "b".repeat(64) };
    const third = { ...input, seq: 3, requestHash: "c".repeat(64) };

    expect(await store.begin(second)).toEqual({
      kind: "rejected",
      reason: "out-of-order",
      expectedSeq: 1,
    });
    expect(await store.begin(input)).toEqual({ kind: "claimed" });
    expect(await store.begin(second)).toEqual({
      kind: "rejected",
      reason: "out-of-order",
      expectedSeq: 1,
    });
    await store.complete({ ...input, outcome: SUCCESS_OUTCOME });
    expect(await store.begin(third)).toEqual({
      kind: "rejected",
      reason: "out-of-order",
      expectedSeq: 2,
    });
    expect(await store.begin(second)).toEqual({ kind: "claimed" });
    expect(await store.complete({ ...second, outcome: ERROR_OUTCOME })).toEqual(ERROR_OUTCOME);
    expect(await store.begin(second)).toEqual({ kind: "replay", outcome: ERROR_OUTCOME });
    expect(await store.begin(third)).toEqual({ kind: "claimed" });
  });

  it("keeps the first cached terminal outcome", async () => {
    await expect(store.complete({ ...input, outcome: SUCCESS_OUTCOME })).rejects.toThrow(
      "must begin before terminal completion",
    );
    await store.begin(input);
    expect(await store.complete({ ...input, outcome: SUCCESS_OUTCOME })).toEqual(SUCCESS_OUTCOME);
    expect(await store.complete({ ...input, outcome: ERROR_OUTCOME })).toEqual(SUCCESS_OUTCOME);
  });

  it("releases only the exact pending reservation without rewinding or releasing its owner", async () => {
    await store.begin(input);
    await store.discardUncommitted({ ...input, requestHash: "b".repeat(64) });
    await store.discardUncommitted({ ...input, environmentId: "worker-b" });
    expect(await store.begin(input)).toEqual({ kind: "recover" });

    await store.discardUncommitted(input);
    const replacement = { ...input, requestHash: "b".repeat(64) };
    expect(await store.begin({ ...replacement, environmentId: "worker-b" })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
    expect(await store.begin(replacement)).toEqual({ kind: "claimed" });
    await store.complete({ ...replacement, outcome: SUCCESS_OUTCOME });
    await store.discardUncommitted(replacement);
    expect(await store.begin(replacement)).toEqual({ kind: "replay", outcome: SUCCESS_OUTCOME });
    expect(await store.begin({ ...input, seq: 2 })).toEqual({ kind: "claimed" });
  });

  it("starts an independent sequence for a later owner epoch", async () => {
    expect(await store.begin(input)).toEqual({ kind: "claimed" });
    await store.complete({ ...input, outcome: SUCCESS_OUTCOME });
    const replacement = {
      ...input,
      environmentId: "worker-b",
      runEpoch: input.runEpoch + 1,
    };

    expect(await store.begin(replacement)).toEqual({ kind: "claimed" });
    expect(await store.complete({ ...replacement, outcome: SUCCESS_OUTCOME })).toEqual(
      SUCCESS_OUTCOME,
    );
  });

  it("preserves submission order and captures inputs before yielding", async () => {
    const submitted = { ...input };
    const first = store.begin(submitted);
    submitted.requestHash = "b".repeat(64);
    const collision = store.begin(submitted);
    expect(await first).toEqual({ kind: "claimed" });
    expect(await collision).toEqual({ kind: "rejected", reason: "conflict" });
    const completion = { ...input, outcome: structuredClone(SUCCESS_OUTCOME) };
    const completed = store.complete(completion);
    if (completion.outcome.ok) {
      completion.outcome.result.entryIds[0] = "mutated-after-submission";
    }
    const next = store.begin({ ...input, seq: 2 });
    expect(await completed).toEqual(SUCCESS_OUTCOME);
    expect(await next).toEqual({ kind: "claimed" });
  });

  it.each(["transaction", "commit"] as const)(
    "rechecks live caller authority at %s admission and rolls back the pending claim",
    async (stage) => {
      let revoked = false;
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
        (admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === stage) {
              revoked = true;
            }
            admit(request, grant);
          }, attachment),
      );
      await expect(
        store.begin(input, () => {
          if (revoked) {
            throw new Error("ledger caller revoked");
          }
        }),
      ).rejects.toThrow("ledger caller revoked");
      expect(revoked).toBe(true);
      expect(await store.begin(input)).toEqual({ kind: "claimed" });
    },
  );

  it("retains a pending record when completion loses current authority", async () => {
    await store.begin(input);
    let revoked = false;
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            revoked = true;
          }
          admit(request, grant);
        }, attachment),
    );
    await expect(
      store.complete({ ...input, outcome: SUCCESS_OUTCOME }, () => {
        if (revoked) {
          throw new Error("ledger completion revoked");
        }
      }),
    ).rejects.toThrow("ledger completion revoked");
    expect(revoked).toBe(true);
    expect(await store.begin(input)).toEqual({ kind: "recover" });
    expect(await store.begin({ ...input, seq: 2 })).toEqual({
      kind: "rejected",
      reason: "out-of-order",
      expectedSeq: 1,
    });
  });

  it.each(
    (["begin", "complete", "discard"] as const).flatMap((operation) =>
      (["committed", "unknown"] as const).map((outcome) => ({ operation, outcome })),
    ),
  )(
    "preserves $outcome $operation settlement after a lost worker reply",
    async ({ operation, outcome }) => {
      if (operation !== "begin") {
        await store.begin(input);
      }
      if (outcome === "unknown") {
        vi.spyOn(operationAdmission, "observeSqliteWorkerCommittedFacts").mockImplementationOnce(
          () => {},
        );
        const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
          (admit, attachment) => {
            const admission = createAdmission(admit, attachment);
            return {
              ...admission,
              get committed() {
                return undefined;
              },
              get settlement() {
                return { kind: "unknown" as const };
              },
            };
          },
        );
      }
      const receive = brokerReply.receiveSqliteWorkerReply;
      let corrupted = 0;
      const replySpy = vi
        .spyOn(brokerReply, "receiveSqliteWorkerReply")
        .mockImplementation((slot, reply, owner) => {
          if (
            slot.current?.request.type === "execute" &&
            reply.ok &&
            !reply.transfer &&
            !reply.input
          ) {
            const value: unknown = deserialize(reply.value);
            if (
              value === true ||
              (isRecord(value) && (value.kind === "claimed" || value.ok === true))
            ) {
              corrupted += 1;
              return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
            }
          }
          return receive(slot, reply, owner);
        });
      const pending =
        operation === "begin"
          ? store.begin(input)
          : operation === "complete"
            ? store.complete({ ...input, outcome: SUCCESS_OUTCOME })
            : store.discardUncommitted(input);
      if (outcome === "unknown") {
        await expect(pending).rejects.toThrow();
      } else {
        await expect(pending).resolves.toEqual(
          operation === "begin"
            ? { kind: "claimed" }
            : operation === "complete"
              ? SUCCESS_OUTCOME
              : undefined,
        );
      }
      expect(corrupted).toBe(1);
      replySpy.mockRestore();
      // An explicit subsequent request observes durable state; the failed call never replayed.
      expect(await store.begin(input)).toEqual(
        operation === "begin"
          ? { kind: "recover" }
          : operation === "complete"
            ? { kind: "replay", outcome: SUCCESS_OUTCOME }
            : { kind: "claimed" },
      );
    },
  );

  it("joins accepted ledger work before close and refuses the retired store", async () => {
    const arrived = createDeferredCore<() => void>();
    const receive = brokerReply.receiveSqliteWorkerReply;
    const replySpy = vi
      .spyOn(brokerReply, "receiveSqliteWorkerReply")
      .mockImplementation((slot, reply, owner) => {
        if (
          slot.current?.request.type === "execute" &&
          reply.ok &&
          !reply.transfer &&
          !reply.input
        ) {
          const value: unknown = deserialize(reply.value);
          if (isRecord(value) && value.kind === "claimed") {
            arrived.resolve(() => receive(slot, reply, owner));
            return;
          }
        }
        return receive(slot, reply, owner);
      });
    const retired = store;
    const pending = retired.begin(input);
    const deliver = await awaitGateBeforeSettlement(
      arrived.promise,
      pending,
      "ledger settled before its reply",
    );
    const closing = closeStateDatabaseForTest();
    try {
      deliver();
      expect(await pending).toEqual({ kind: "claimed" });
      await closing;
    } finally {
      replySpy.mockRestore();
      await Promise.allSettled([pending, closing]);
    }
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerTranscriptCommitStore({ database, now: () => nowMs });
    await expect(retired.complete({ ...input, outcome: SUCCESS_OUTCOME })).rejects.toThrow();
    expect(await store.begin(input)).toEqual({ kind: "recover" });
  });
});
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
