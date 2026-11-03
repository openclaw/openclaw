// Continuation (karmaterminal): /continuations cancel is the explicit "stop the search"
// (karmaterminal/openclaw#1271). Real command handler and real custody.
import { expect, it } from "vitest";
import {
  readCustodyRecordForTest,
  useContinuationCustodyTestState,
} from "../continuation/custody/custody.test-support.js";
import {
  consumePendingDelegates,
  enqueuePendingDelegate,
  markPendingDelegateSpawnAccepted,
} from "../continuation/delegate-store.js";
import { enqueuePendingWorkReplacing } from "../continuation/work-replacement-store.js";
import { handleContinuationsCommand } from "./commands-continuations.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

useContinuationCustodyTestState();

const sessionKey = "agent:main:main";

async function electWork(reason: string): Promise<string> {
  const now = Date.now();
  const elected = await enqueuePendingWorkReplacing({
    work: {
      sessionKey,
      hop: 1,
      delayMs: 60_000,
      electedAt: now,
      dueAt: now + 60_000,
      anchorFinalizedAt: now,
      maxChainLength: 8,
      reason,
    },
    summary: reason,
    maxPendingWork: 8,
    replaceParkedWork: false,
    expectedRunningFlowIds: [],
  });
  if (!elected.applied || !elected.work.flowId) {
    throw new Error("expected durable continuation work");
  }
  return elected.work.flowId;
}

async function runCommand(body: string, owner = true) {
  const params = buildCommandTestParams(body, baseCommandTestConfig);
  params.command.senderIsOwner = owner;
  return (await handleContinuationsCommand(params, true))?.reply?.text ?? "";
}

it("cancels exactly the named records and replies with a receipt for each", async () => {
  const keep = await enqueuePendingDelegate(sessionKey, {
    task: "keep searching the east wing",
    delayMs: 60_000,
  });
  const stop = await enqueuePendingDelegate(sessionKey, {
    task: "search the winter annex",
    delayMs: 60_000,
  });
  const stopWork = await electWork("come back to the annex search");
  const keepWork = await electWork("come back to the east wing");
  const admitted = await enqueuePendingDelegate(sessionKey, { task: "already running" });
  const [claimed] = await consumePendingDelegates(sessionKey);
  expect(claimed?.flowId).toBe(admitted.recordId);
  expect(await markPendingDelegateSpawnAccepted(claimed!, "agent:main:subagent:running")).toBe(
    true,
  );
  const foreign = await enqueuePendingDelegate("agent:main:other", { task: "another session's" });

  const listing = await runCommand("/continuations");
  for (const recordId of [keep.recordId, stop.recordId, stopWork, keepWork]) {
    expect(listing).toContain(recordId);
  }
  expect(listing).not.toContain(admitted.recordId);
  expect(listing).not.toContain(foreign.recordId);

  const receipt = await runCommand(
    `/continuations cancel ${stop.recordId} ${stopWork} ${admitted.recordId} ${foreign.recordId}`,
  );

  expect(receipt.split("\n")).toEqual([
    "Continuation cancel receipt:",
    `• ${stop.recordId} · delegate · was queued → cancelled`,
    `• ${stopWork} · work · was queued → cancelled`,
    `• ${admitted.recordId} · delegate · was succeeded → handed-off (child agent:main:subagent:running)`,
    `• ${foreign.recordId} → not-found`,
  ]);
  expect(await readCustodyRecordForTest(stop.recordId)).toMatchObject({
    status: "cancelled",
    phase: "Cancelled by owner",
  });
  expect(await readCustodyRecordForTest(stopWork)).toMatchObject({ status: "cancelled" });
  for (const recordId of [keep.recordId, keepWork, foreign.recordId]) {
    expect(await readCustodyRecordForTest(recordId)).toMatchObject({ status: "queued" });
  }
  expect(await readCustodyRecordForTest(admitted.recordId)).toMatchObject({
    status: "succeeded",
  });
});

it("refuses cancel from a sender who is not the owner and ends nothing", async () => {
  const stop = await enqueuePendingDelegate(sessionKey, { task: "not yours to stop" });

  const reply = await runCommand(`/continuations cancel ${stop.recordId}`, false);

  expect(reply).toContain("owner-only");
  expect(await readCustodyRecordForTest(stop.recordId)).toMatchObject({ status: "queued" });
});
