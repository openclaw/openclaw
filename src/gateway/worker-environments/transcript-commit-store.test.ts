import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
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
const CLAIMED = { kind: "claimed" };
const CONFLICT = { kind: "rejected", reason: "conflict" };
const OUT_OF_ORDER = { kind: "rejected", reason: "out-of-order", expectedSeq: 1 };
const RECOVER = { kind: "recover" };
const REPLAY = { kind: "replay", outcome: SUCCESS_OUTCOME };
const SETTLEMENT = {
  begin: { result: CLAIMED, next: RECOVER },
  complete: { result: SUCCESS_OUTCOME, next: REPLAY },
  discard: { result: undefined, next: CLAIMED },
};

function revokeAt(stage: "transaction" | "commit", message: string) {
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
  return {
    assertCurrent: () => {
      if (revoked) {
        throw new Error(message);
      }
    },
    expectRevoked: () => expect(revoked).toBe(true),
  };
}

function ledgerReplyValue(
  slot: Parameters<typeof brokerReply.receiveSqliteWorkerReply>[0],
  reply: Parameters<typeof brokerReply.receiveSqliteWorkerReply>[1],
): unknown {
  return slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input
    ? deserialize(reply.value)
    : undefined;
}

describe("worker transcript commit store", () => {
  let root: string;
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
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerTranscriptCommitStore({ database, now: () => 1_000 });
  });

  beforeEach(() => {
    input = { ...BASE_INPUT, sessionId: `session-${++sequence}` };
  });
  afterEach(() => vi.restoreAllMocks());

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
    expect(await store.begin(input)).toEqual(CLAIMED);
    expect(await store.begin({ ...input, requestHash: "b".repeat(64) })).toEqual(CONFLICT);
    await store.complete({ ...input, outcome: SUCCESS_OUTCOME });
    expect(await store.begin({ ...input, requestHash: "b".repeat(64) })).toEqual(CONFLICT);
    expect(await store.begin({ ...input, environmentId: "worker-b" })).toEqual(CONFLICT);
  });

  it("advances one ordered sequence only after terminal completion", async () => {
    const second = { ...input, seq: 2, requestHash: "b".repeat(64) };
    const third = { ...input, seq: 3, requestHash: "c".repeat(64) };

    expect(await store.begin(second)).toEqual(OUT_OF_ORDER);
    expect(await store.begin(input)).toEqual(CLAIMED);
    expect(await store.begin(second)).toEqual(OUT_OF_ORDER);
    await store.complete({ ...input, outcome: SUCCESS_OUTCOME });
    expect(await store.begin(third)).toEqual({ ...OUT_OF_ORDER, expectedSeq: 2 });
    expect(await store.begin(second)).toEqual(CLAIMED);
    expect(await store.complete({ ...second, outcome: ERROR_OUTCOME })).toEqual(ERROR_OUTCOME);
    expect(await store.begin(second)).toEqual({ kind: "replay", outcome: ERROR_OUTCOME });
    expect(await store.begin(third)).toEqual(CLAIMED);
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
    expect(await store.begin(input)).toEqual(RECOVER);

    await store.discardUncommitted(input);
    const replacement = { ...input, requestHash: "b".repeat(64) };
    expect(await store.begin({ ...replacement, environmentId: "worker-b" })).toEqual(CONFLICT);
    expect(await store.begin(replacement)).toEqual(CLAIMED);
    await store.complete({ ...replacement, outcome: SUCCESS_OUTCOME });
    await store.discardUncommitted(replacement);
    expect(await store.begin(replacement)).toEqual(REPLAY);
    expect(await store.begin({ ...input, seq: 2 })).toEqual(CLAIMED);
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
    expect(await first).toEqual(CLAIMED);
    expect(await collision).toEqual(CONFLICT);
    const completion = { ...input, outcome: structuredClone(SUCCESS_OUTCOME) };
    const completed = store.complete(completion);
    if (completion.outcome.ok) {
      completion.outcome.result.entryIds[0] = "mutated-after-submission";
    }
    const next = store.begin({ ...input, seq: 2 });
    expect(await completed).toEqual(SUCCESS_OUTCOME);
    expect(await next).toEqual(CLAIMED);
  });

  it.each(["transaction", "commit"] as const)(
    "rechecks live caller authority at %s admission and rolls back the pending claim",
    async (stage) => {
      const authority = revokeAt(stage, "ledger caller revoked");
      await expect(store.begin(input, authority.assertCurrent)).rejects.toThrow(
        "ledger caller revoked",
      );
      authority.expectRevoked();
      expect(await store.begin(input)).toEqual(CLAIMED);
    },
  );

  it("retains a pending record when completion loses current authority", async () => {
    await store.begin(input);
    const authority = revokeAt("commit", "ledger completion revoked");
    await expect(
      store.complete({ ...input, outcome: SUCCESS_OUTCOME }, authority.assertCurrent),
    ).rejects.toThrow("ledger completion revoked");
    authority.expectRevoked();
    expect(await store.begin(input)).toEqual(RECOVER);
    expect(await store.begin({ ...input, seq: 2 })).toEqual(OUT_OF_ORDER);
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
              committed: undefined,
              settlement: { kind: "unknown" as const },
            };
          },
        );
      }
      const receive = brokerReply.receiveSqliteWorkerReply;
      let corrupted = 0;
      const replySpy = vi
        .spyOn(brokerReply, "receiveSqliteWorkerReply")
        .mockImplementation((slot, reply, owner) => {
          const value = ledgerReplyValue(slot, reply);
          if (
            reply.ok &&
            (value === true || (isRecord(value) && (value.kind === "claimed" || value.ok === true)))
          ) {
            corrupted += 1;
            return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
          }
          return receive(slot, reply, owner);
        });
      const pending = {
        begin: () => store.begin(input),
        complete: () => store.complete({ ...input, outcome: SUCCESS_OUTCOME }),
        discard: () => store.discardUncommitted(input),
      }[operation]();
      if (outcome === "unknown") {
        await expect(pending).rejects.toThrow();
      } else {
        await expect(pending).resolves.toEqual(SETTLEMENT[operation].result);
      }
      expect(corrupted).toBe(1);
      replySpy.mockRestore();
      // An explicit subsequent request observes durable state; the failed call never replayed.
      expect(await store.begin(input)).toEqual(SETTLEMENT[operation].next);
    },
  );

  it("joins accepted ledger work before close and refuses the retired store", async () => {
    const arrived = createDeferredCore<() => void>();
    const receive = brokerReply.receiveSqliteWorkerReply;
    const replySpy = vi
      .spyOn(brokerReply, "receiveSqliteWorkerReply")
      .mockImplementation((slot, reply, owner) => {
        const value = ledgerReplyValue(slot, reply);
        if (isRecord(value) && value.kind === "claimed") {
          arrived.resolve(() => receive(slot, reply, owner));
          return;
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
      expect(await pending).toEqual(CLAIMED);
      await closing;
    } finally {
      replySpy.mockRestore();
      await Promise.allSettled([pending, closing]);
    }
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerTranscriptCommitStore({ database, now: () => 1_000 });
    await expect(retired.complete({ ...input, outcome: SUCCESS_OUTCOME })).rejects.toThrow();
    expect(await store.begin(input)).toEqual(RECOVER);
  });
});
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
