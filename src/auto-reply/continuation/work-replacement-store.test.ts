import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContinuationRecord, updateContinuationRecords } from "./custody/custody-store.js";
import type { ContinuationRecord } from "./custody/custody-store.types.js";
import {
  custodyStateForTest,
  listCustodyRecordsForTest,
  readCustodyRecordForTest,
  useContinuationCustodyTestState,
} from "./custody/custody.test-support.js";
import {
  decodeWorkState,
  encodeWorkState,
  type PendingContinuationWork,
} from "./work-flow-state.js";
import {
  enqueuePendingWorkReplacing,
  rollbackPendingWorkReplacement,
} from "./work-replacement-store.js";
import { consumePendingWork, requeuePendingWork } from "./work-store.js";
import { enqueuePendingWork } from "./work-store.test-support.js";

// A concurrent writer lands between an election's snapshot read and its
// transactional write: the hook runs just before each election command is
// handed to the state worker, as another Gateway task's commit would.
const workerHooks = vi.hoisted(() => ({
  beforeElect: [] as Array<() => Promise<void>>,
  running: false,
}));

vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  const probeStop = new Error("command probe");
  async function commandType(
    operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
  ): Promise<string | undefined> {
    let type: string | undefined;
    try {
      await operation({
        execute: async (command: { type?: string }) => {
          type = command.type;
          throw probeStop;
        },
      } as never);
    } catch {
      // The probe only reads the command type; it never reaches the worker.
    }
    return type;
  }
  return {
    ...actual,
    runOpenClawStateWorkerOperation: async (
      ...args: Parameters<typeof actual.runOpenClawStateWorkerOperation>
    ) => {
      const [, operation] = args;
      if (
        !workerHooks.running &&
        workerHooks.beforeElect.length > 0 &&
        (await commandType(operation)) === "continuationCustody.elect"
      ) {
        const hook = workerHooks.beforeElect.shift();
        workerHooks.running = true;
        try {
          await hook?.();
        } finally {
          workerHooks.running = false;
        }
      }
      return await actual.runOpenClawStateWorkerOperation(...args);
    },
  };
});

useContinuationCustodyTestState();

function createWork(params: {
  sessionKey: string;
  reason: string;
  electedAt: number;
  parked: boolean;
  originRunId?: string;
  originTurnId?: string;
}): PendingContinuationWork {
  return {
    sessionKey: params.sessionKey,
    hop: 1,
    delayMs: 30_000,
    electedAt: params.electedAt,
    dueAt: params.electedAt + 60_000,
    maxChainLength: 200,
    chainStartedAt: params.electedAt,
    accumulatedChainTokens: 0,
    reason: params.reason,
    ...(params.originRunId ? { originRunId: params.originRunId } : {}),
    ...(params.originTurnId ? { originTurnId: params.originTurnId } : {}),
    ...(params.parked
      ? {
          anchorPending: true,
          idleRetry: {
            trigger: "reply-run-ended" as const,
            reasonCategory: "follow-up-work" as const,
            armedAt: params.electedAt,
          },
        }
      : { anchorFinalizedAt: params.electedAt }),
  };
}

async function findRecord(
  sessionKey: string,
  reason: string,
): Promise<ContinuationRecord | undefined> {
  return (await listCustodyRecordsForTest({ ownerSessionKey: sessionKey })).find(
    (record) => custodyStateForTest(record).reason === reason,
  );
}

async function markRunning(record: Pick<ContinuationRecord, "recordId" | "ownerSessionKey">) {
  const current = await readCustodyRecordForTest(record.recordId);
  if (!current) {
    throw new Error(`expected custody record ${record.recordId}`);
  }
  return await updateContinuationRecords(
    [
      {
        recordId: current.recordId,
        ownerSessionKey: current.ownerSessionKey,
        expectedRevision: current.revision,
        patch: { status: "running", phase: "Released to continuation wake scheduler" },
      },
    ],
    { now: Date.now() },
  );
}

describe("continuation work replacement store", () => {
  beforeEach(() => {
    workerHooks.beforeElect.length = 0;
    workerHooks.running = false;
  });

  it("serializes two parked replacements that begin with no queued owner", async () => {
    const sessionKey = "agent:main:empty-owner";
    workerHooks.beforeElect.push(async () => {
      expect(
        await enqueuePendingWork(
          createWork({
            sessionKey,
            reason: "concurrent empty-owner parked work",
            electedAt: Date.now(),
            parked: true,
          }),
        ),
      ).not.toBeNull();
    });

    const result = await enqueuePendingWorkReplacing({
      work: createWork({
        sessionKey,
        reason: "newest empty-owner parked work",
        electedAt: Date.now() + 1,
        parked: true,
      }),
      summary: "superseded by concurrent empty-owner replacement",
      maxPendingWork: 8,
      replaceParkedWork: true,
      expectedRunningFlowIds: [],
    });

    expect(result.applied).toBe(true);
    expect(workerHooks.beforeElect).toEqual([]);
    expect(await findRecord(sessionKey, "concurrent empty-owner parked work")).toMatchObject({
      status: "succeeded",
    });
    const queued = await listCustodyRecordsForTest({
      ownerSessionKey: sessionKey,
      statuses: ["queued"],
    });
    expect(queued.map((record) => custodyStateForTest(record).reason)).toEqual([
      "newest empty-owner parked work",
    ]);
  });

  it("rejects a newly running owner discovered from an empty snapshot", async () => {
    const sessionKey = "agent:main:running-owner";
    workerHooks.beforeElect.push(async () => {
      const concurrent = await enqueuePendingWork(
        createWork({
          sessionKey,
          reason: "concurrent running work",
          electedAt: Date.now(),
          parked: true,
        }),
      );
      if (!concurrent?.flowId) {
        throw new Error("expected concurrent parked record");
      }
      expect(
        (await markRunning({ recordId: concurrent.flowId, ownerSessionKey: sessionKey })).outcome,
      ).toBe("applied");
    });

    const result = await enqueuePendingWorkReplacing({
      work: createWork({
        sessionKey,
        reason: "rejected newest work",
        electedAt: Date.now() + 1,
        parked: true,
      }),
      summary: "superseded by empty-owner replacement",
      maxPendingWork: 8,
      replaceParkedWork: true,
      expectedRunningFlowIds: [],
    });

    expect(result).toMatchObject({ applied: false, reason: "running_owner" });
    expect(await findRecord(sessionKey, "concurrent running work")).toMatchObject({
      status: "running",
    });
    expect(await findRecord(sessionKey, "rejected newest work")).toBeUndefined();
  });

  it("enforces maxPendingWork transactionally for ordinary enqueues", async () => {
    const sessionKey = "agent:main:ordinary-cap";
    workerHooks.beforeElect.push(async () => {
      expect(
        await enqueuePendingWork(
          createWork({
            sessionKey,
            reason: "concurrent ordinary work",
            electedAt: Date.now(),
            parked: false,
          }),
        ),
      ).not.toBeNull();
    });

    const result = await enqueuePendingWorkReplacing({
      work: createWork({
        sessionKey,
        reason: "capped ordinary work",
        electedAt: Date.now() + 1,
        parked: false,
      }),
      summary: "ordinary enqueue",
      maxPendingWork: 1,
      replaceParkedWork: false,
      expectedRunningFlowIds: [],
    });

    expect(result).toEqual({ applied: false, capped: true });
    const records = await listCustodyRecordsForTest({ ownerSessionKey: sessionKey });
    expect(records.map((record) => custodyStateForTest(record).reason)).toEqual([
      "concurrent ordinary work",
    ]);
  });

  it("rejects a queued owner that becomes running inside ordinary admission", async () => {
    const sessionKey = "agent:main:status-race";
    workerHooks.beforeElect.push(
      async () => {
        expect(
          await enqueuePendingWork(
            createWork({
              sessionKey,
              reason: "concurrent queued work",
              electedAt: Date.now(),
              parked: false,
            }),
          ),
        ).not.toBeNull();
      },
      async () => {
        const concurrent = await findRecord(sessionKey, "concurrent queued work");
        if (!concurrent) {
          throw new Error("expected concurrent queued record");
        }
        expect((await markRunning(concurrent)).outcome).toBe("applied");
      },
    );

    const result = await enqueuePendingWorkReplacing({
      work: createWork({
        sessionKey,
        reason: "rejected overlapping work",
        electedAt: Date.now() + 1,
        parked: false,
      }),
      summary: "ordinary enqueue",
      maxPendingWork: 8,
      replaceParkedWork: false,
      expectedRunningFlowIds: [],
    });

    expect(result).toMatchObject({ applied: false, reason: "revision_conflict" });
    expect(workerHooks.beforeElect).toEqual([]);
    expect(await findRecord(sessionKey, "concurrent queued work")).toMatchObject({
      status: "running",
    });
    expect(await findRecord(sessionKey, "rejected overlapping work")).toBeUndefined();
  });

  // RFC §5.4.3 and §9.2.2 item 1: a concurrent election, and a claim racing
  // the replanned election, each fail the owner condition; the loser commits
  // nothing and the winner's and the superseded prior's records are intact.
  it("lets exactly one of two racing elections win and commits nothing for the loser", async () => {
    const sessionKey = "agent:main:racing-elections";
    const parked = await enqueuePendingWork(
      createWork({
        sessionKey,
        reason: "parked prior",
        electedAt: Date.now(),
        parked: true,
      }),
    );
    if (!parked?.flowId) {
      throw new Error("expected a parked prior");
    }
    const priorBefore = await readCustodyRecordForTest(parked.flowId);
    let winner: Awaited<ReturnType<typeof enqueuePendingWorkReplacing>> | undefined;
    const winnerWork = createWork({
      sessionKey,
      reason: "winning election",
      electedAt: Date.now() + 1,
      parked: true,
    });
    workerHooks.beforeElect.push(
      // The rival election commits first and supersedes the parked prior.
      async () => {
        winner = await enqueuePendingWorkReplacing({
          work: winnerWork,
          summary: "superseded by the winning election",
          maxPendingWork: 8,
          replaceParkedWork: true,
          expectedRunningFlowIds: [],
        });
      },
      // The loser replans against the winner; a claim of the winner lands
      // before the loser's second write.
      async () => {
        if (!winner?.applied || !winner.work.flowId) {
          throw new Error("expected the rival election to win");
        }
        expect(
          (await markRunning({ recordId: winner.work.flowId, ownerSessionKey: sessionKey }))
            .outcome,
        ).toBe("applied");
      },
    );

    const loser = await enqueuePendingWorkReplacing({
      work: createWork({
        sessionKey,
        reason: "losing election",
        electedAt: Date.now() + 2,
        parked: true,
      }),
      summary: "superseded by the losing election",
      maxPendingWork: 8,
      replaceParkedWork: true,
      expectedRunningFlowIds: [],
    });

    expect(workerHooks.beforeElect).toEqual([]);
    expect(loser).toEqual({ applied: false, capped: false, reason: "revision_conflict" });
    expect(await findRecord(sessionKey, "losing election")).toBeUndefined();

    if (!winner?.applied || !winner.work.flowId || !priorBefore) {
      throw new Error("expected the winning election and its superseded prior");
    }
    const winnerRecord = await readCustodyRecordForTest(winner.work.flowId);
    expect(winnerRecord).toMatchObject({
      status: "running",
      revision: 1,
      phase: "Released to continuation wake scheduler",
    });
    expect(winnerRecord?.cancelRequestedAt).toBeUndefined();
    // The winner's state is exactly what it elected: the loser never wrote it.
    expect(winnerRecord?.stateJson).toBe(JSON.stringify(encodeWorkState(winnerWork)));

    // The prior was superseded once, by the winner, and never touched again.
    const prior = await readCustodyRecordForTest(parked.flowId);
    expect(prior).toMatchObject({
      status: "succeeded",
      revision: priorBefore.revision + 1,
      phase: "superseded: superseded by the winning election",
    });
    const { idleRetry: _idleRetry, ...priorStateBefore } = custodyStateForTest(priorBefore);
    expect(prior && custodyStateForTest(prior)).toEqual({
      ...priorStateBefore,
      turnGrantedAt: expect.any(Number),
    });
    expect(winner.supersededFlows).toEqual([priorBefore]);
  });

  // RFC §5.4.2 "Work-scheduling rollback" and §9.2.2 item 1.
  it("rolls back an election by restoring its superseded prior exactly and marking rollbackOf", async () => {
    const sessionKey = "agent:main:rollback";
    const parked = await enqueuePendingWork(
      createWork({
        sessionKey,
        reason: "parked prior to restore",
        electedAt: Date.now(),
        parked: true,
      }),
    );
    if (!parked?.flowId) {
      throw new Error("expected a parked prior");
    }
    const priorBefore = await readCustodyRecordForTest(parked.flowId);
    if (!priorBefore) {
      throw new Error("expected the parked prior record");
    }

    const elected = await enqueuePendingWorkReplacing({
      work: createWork({
        sessionKey,
        reason: "election whose turn failed to finalize",
        electedAt: Date.now() + 1,
        parked: true,
        originRunId: "run-electing",
        originTurnId: "turn-electing",
      }),
      summary: "superseded by the failing election",
      maxPendingWork: 8,
      replaceParkedWork: true,
      expectedRunningFlowIds: [],
    });
    if (!elected.applied || !elected.work.flowId) {
      throw new Error("expected the election to apply");
    }
    expect(await readCustodyRecordForTest(parked.flowId)).toMatchObject({ status: "succeeded" });

    const rollback = await rollbackPendingWorkReplacement({
      sessionKey,
      createdFlowIds: [elected.work.flowId],
      priorFlows: elected.supersededFlows,
      originRunId: "run-electing",
      originTurnId: "turn-electing",
      summary: "electing turn failed to finalize",
    });

    expect(rollback).toEqual({
      applied: true,
      unresolvedCreatedFlowIds: [],
      unrestoredPriorFlowIds: [],
    });
    const restored = await readCustodyRecordForTest(parked.flowId);
    expect(restored).toMatchObject({
      status: "queued",
      phase: priorBefore.phase,
      stateJson: priorBefore.stateJson,
      rollbackOf: elected.work.flowId,
      revision: priorBefore.revision + 2,
    });
    expect(restored?.cancelRequestedAt).toBe(priorBefore.cancelRequestedAt);
    expect(restored?.endedAt).toBeUndefined();
    expect(restored?.failureReason).toBeUndefined();
    expect(await readCustodyRecordForTest(elected.work.flowId)).toMatchObject({
      status: "failed",
      phase: "spawn-init continuation finalization failed",
      failureReason: "electing turn failed to finalize",
    });

    // A replayed rollback recognizes the exact restore and changes nothing.
    expect(
      await rollbackPendingWorkReplacement({
        sessionKey,
        createdFlowIds: [elected.work.flowId],
        priorFlows: elected.supersededFlows,
        originRunId: "run-electing",
        originTurnId: "turn-electing",
        summary: "electing turn failed to finalize",
      }),
    ).toEqual({ applied: true, unresolvedCreatedFlowIds: [], unrestoredPriorFlowIds: [] });
    expect(await readCustodyRecordForTest(parked.flowId)).toEqual(restored);
  });
});

// karmaterminal/openclaw#1271: the optional `recipientAuthority` work-state field.
describe("continuation work recipient-authority codec", () => {
  /** Writes state JSON verbatim, as the build that wrote it would have. */
  async function writeRaw(sessionKey: string, state: Record<string, unknown>) {
    const created = await createContinuationRecord({
      recordId: randomUUID(),
      kind: "work",
      ownerSessionKey: sessionKey,
      status: "queued",
      phase: "Queued for same-session continuation wake",
      createdAt: Number(state.electedAt),
      dueAt: Number(state.dueAt),
      stateJson: JSON.stringify(state),
    });
    if (created.outcome !== "created") {
      throw new Error("expected a raw continuation work record");
    }
    return created.record;
  }
  const oldShape = (sessionKey: string, electedAt: number) => ({
    kind: "continuation_work",
    sessionKey,
    hop: 1,
    delayMs: 0,
    electedAt,
    dueAt: electedAt,
    maxChainLength: 8,
    reason: "written before the binding existed",
  });

  it("keeps the binding through the store's own rewrites and reads the old shape unchanged", async () => {
    const now = Date.now();
    const authority = { state: "bound" as const, epoch: randomUUID() };
    const work = createWork({
      sessionKey: "agent:main:codec",
      reason: "bound",
      electedAt: now,
      parked: false,
    });
    const bound = await enqueuePendingWork({ ...work, recipientAuthority: authority });
    expect(await requeuePendingWork(bound!, { dueAt: now + 5_000, summary: "retry" })).toBe(true);
    const rewritten = (await readCustodyRecordForTest(bound!.flowId!))!;
    expect(custodyStateForTest(rewritten).recipientAuthority).toEqual(authority);
    expect(decodeWorkState(rewritten)?.recipientAuthority).toEqual(authority);

    const legacy = await writeRaw("agent:main:codec-old", oldShape("agent:main:codec-old", now));
    expect(decodeWorkState(legacy)).toEqual(oldShape("agent:main:codec-old", now));
  });

  it("fails a malformed binding closed instead of reading the record as unbound", async () => {
    const now = Date.now() - 1;
    const record = await writeRaw("agent:main:codec-malformed", {
      ...oldShape("agent:main:codec-malformed", now),
      recipientAuthority: { state: "bound", epoch: "not-an-epoch" },
    });
    expect(decodeWorkState(record)).toBeUndefined();
    expect(await consumePendingWork("agent:main:codec-malformed")).toEqual([]);
    expect(await readCustodyRecordForTest(record.recordId)).toMatchObject({
      status: "failed",
      phase: "Rejected invalid continuation work payload",
    });
  });
});
