import { afterEach, expect, test, vi } from "vitest";
import {
  registerContinuationDispatchClaim,
  resetContinuationDispatchClaimsForTests,
} from "../auto-reply/continuation/continuation-dispatch-claims.js";
import { resetContinuationCustodyProjection } from "../auto-reply/continuation/custody/custody-projection.js";
import { readCustodyRecordForTest } from "../auto-reply/continuation/custody/custody.test-support.js";
import { stagePostCompactionDelegate } from "../auto-reply/continuation/delegate-store-post-compaction.js";
import { enqueuePendingDelegate } from "../auto-reply/continuation/delegate-store.js";
import { enqueuePendingWorkReplacing } from "../auto-reply/continuation/work-replacement-store.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

// A custody write that throws is the store's persistence failure (the worker
// command did not report a commit); reset must surface it and leave custody,
// the session, and live claims intact for a retry.
const custodyWriteFailure = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("../auto-reply/continuation/custody/custody-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/continuation/custody/custody-store.js")>();
  return {
    ...actual,
    updateContinuationRecords: async (
      ...args: Parameters<typeof actual.updateContinuationRecords>
    ) => {
      if (custodyWriteFailure.message) {
        throw new Error(custodyWriteFailure.message);
      }
      return await actual.updateContinuationRecords(...args);
    },
  };
});

const { seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  custodyWriteFailure.message = undefined;
  resetContinuationDispatchClaimsForTests();
  resetContinuationCustodyProjection();
  closeOpenClawStateDatabaseForTest();
});

async function seedWaitingActiveMainSession() {
  const seeded = await seedActiveMainSession();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);
  return seeded;
}

async function resetMainSession() {
  return await directSessionReq<{
    ok: true;
    key: string;
    entry: { lifecycleRevision?: string; sessionId: string };
  }>("sessions.reset", { key: "main" });
}

async function enqueueQueuedWork() {
  const now = Date.now();
  const elected = await enqueuePendingWorkReplacing({
    work: {
      sessionKey: "agent:main:main",
      hop: 1,
      delayMs: 60_000,
      electedAt: now,
      dueAt: now + 60_000,
      maxChainLength: 8,
    },
    summary: "queued before gateway reset",
    maxPendingWork: 8,
    replaceParkedWork: false,
    expectedRunningFlowIds: [],
  });
  if (!elected.applied || !elected.work.flowId) {
    throw new Error("expected durable continuation work");
  }
  return elected.work.flowId;
}

// karmaterminal/openclaw#1271: a head swap is not a decision to cancel. Queued elections stay for
// the successor; the explicit cancel (/continuations cancel) ends them.
test("sessions.reset keeps queued continuation work and delegates for the successor", async () => {
  await seedWaitingActiveMainSession();
  const workId = await enqueueQueuedWork();
  const delegate = await enqueuePendingDelegate("agent:main:main", {
    task: "delegate after gateway reset",
    delayMs: 60_000,
  });
  const queuedWork = await readCustodyRecordForTest(workId);
  const shard = await stagePostCompactionDelegate("agent:main:main", {
    task: "staged for the replaced head's next compaction",
    createdAt: Date.now(),
  });

  const reset = await resetMainSession();

  expect(reset.ok).toBe(true);
  expect(await readCustodyRecordForTest(workId)).toMatchObject({
    status: "queued",
    revision: queuedWork?.revision,
    dueAt: queuedWork?.dueAt,
  });
  expect(await readCustodyRecordForTest(delegate.recordId)).toMatchObject({ status: "queued" });
  // A post-compaction shard needs a rebind rule before it may outlive its head.
  expect(await readCustodyRecordForTest(shard.recordId)).toMatchObject({
    status: "cancelled",
    phase: "Cancelled by session reset",
  });
});

test("sessions.reset reports durable continuation cancellation failures", async () => {
  const { storePath } = await seedWaitingActiveMainSession();
  const workId = await enqueueQueuedWork();
  const delegate = await enqueuePendingDelegate("agent:main:main", {
    task: "remain claimable after failed reset",
    delayMs: 60_000,
  });
  // The reset still retires this record, so its write is the one that fails.
  const shard = await stagePostCompactionDelegate("agent:main:main", {
    task: "staged shard the reset must retire",
    createdAt: Date.now(),
  });
  const activeDelegate = registerContinuationDispatchClaim({
    sessionKey: "agent:main:main",
    flowId: delegate.recordId,
  });
  custodyWriteFailure.message = "SQLITE_FULL: database or disk is full";

  const reset = await resetMainSession();

  expect(reset.ok).toBe(false);
  expect(reset.error).toMatchObject({
    code: "UNAVAILABLE",
    message: expect.stringContaining("could not cancel continuation record"),
  });
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.sessionId).toBe(
    "sess-main",
  );
  custodyWriteFailure.message = undefined;
  expect(await readCustodyRecordForTest(workId)).toMatchObject({ status: "queued" });
  expect(await readCustodyRecordForTest(delegate.recordId)).toMatchObject({ status: "queued" });
  expect(await readCustodyRecordForTest(shard.recordId)).toMatchObject({ status: "queued" });
  expect(activeDelegate.controller.signal.aborted).toBe(false);
});
