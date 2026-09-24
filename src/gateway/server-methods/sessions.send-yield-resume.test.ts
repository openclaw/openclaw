import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { setSubagentAnnounceDeliveryDepsForTest } from "../../agents/subagents/announce/subagent-announce-overrides.test-support.js";
import { dispatchGatewayMethodInProcess } from "../../agents/subagents/announce/subagent-announce.runtime.js";
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "../../agents/subagents/registry/subagent-registry-run-pause.js";
import { persistSubagentRunsToDiskOrThrow } from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  markRequesterTurnYielded,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { testing as registryTesting } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as transcriptArchive from "../../config/sessions/session-accessor.sqlite-archive.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { findTaskByRunId, getTaskById } from "../../tasks/runtime-internal.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import { sessionSharingTestContext, soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

const chatSend = vi.hoisted(() => vi.fn<GatewayRequestHandler>());
vi.mock("./chat-send-external-entry.js", () => ({ handleDirectExternalChatSend: chatSend }));

const fixture = useSubagentControlFixture();
afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  vi.useRealTimers();
});

it("resumes a yielded child through sessions.send and wakes its original parent after the same batch settles", async () => {
  vi.useFakeTimers();
  const archiveRead = vi.spyOn(transcriptArchive, "runSqliteTranscriptArchiveReadWorker");
  const requesterSessionKey = "agent:main:main";
  const childSessionKey = "agent:main:subagent:paused-child";
  const siblingSessionKey = "agent:main:subagent:completed-sibling";
  const previousRunId = "paused-child-run";
  const nextRunId = "resumed-child-run";
  const siblingRunId = "sibling-run";
  const requesterTurnRunId = "parent-turn";
  const expectCompletedRun = (runId: string, resultText: string) => {
    const entry = expectDefined(subagentRuns.get(runId), `completed run ${runId}`);
    expect(
      entry,
      JSON.stringify({
        runId,
        cleanupHandled: entry.cleanupHandled,
        delivery: entry.delivery,
        requesterSettleWake: entry.requesterSettleWake,
        requesterTurnRunId: entry.requesterTurnRunId,
      }),
    ).toMatchObject({
      execution: { status: "terminal", outcome: { status: "ok" } },
      completion: { resultText },
      cleanupCompletedAt: expect.any(Number),
    });
  };
  const expectSharedRequesterWake = (runIds: string[], batchRunIds: string[]) => {
    const wakes = runIds.map(
      (runId) => expectDefined(subagentRuns.get(runId), `wake owner ${runId}`).requesterSettleWake,
    );
    for (const wake of wakes) {
      expect(wake).toMatchObject({
        batchRunIds: batchRunIds.toSorted(),
        requesterYieldBatch: true,
        rearmGeneration: 1,
      });
    }
    const nextAttemptAt = wakes[0]?.nextAttemptAt;
    expect(Number.isFinite(nextAttemptAt), "durable requester wake deadline").toBe(true);
    expect(nextAttemptAt).toBeGreaterThan(Date.now());
    expect(wakes.map((wake) => wake?.nextAttemptAt)).toEqual(runIds.map(() => nextAttemptAt));
    return nextAttemptAt!;
  };
  const context = sessionSharingTestContext(vi.fn(), getRuntimeConfig());
  context.resolveGatewayContext = () => context;
  const delivery = { dispatch: dispatchGatewayMethodInProcess };
  const dispatch = vi.spyOn(delivery, "dispatch").mockResolvedValue({
    status: "ok",
    result: { payloads: [{ text: "Both results received; parent continues." }], meta: {} },
  });
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: delivery.dispatch });

  for (const sessionKey of [requesterSessionKey, childSessionKey, siblingSessionKey]) {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: `${sessionKey}-session`,
    });
  }
  const children = [
    { runId: previousRunId, childSessionKey, expectsCompletionMessage: true },
    { runId: siblingRunId, childSessionKey: siblingSessionKey, expectsCompletionMessage: true },
  ];
  for (const child of children) {
    registerSubagentRun({
      ...child,
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
      requesterDisplayKey: requesterSessionKey,
      task: "Complete the existing child task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      gatewayContextResolver: context.resolveGatewayContext,
    });
  }
  const originalTask = expectDefined(findTaskByRunId(previousRunId), "original child task");
  expect(
    markRequesterTurnYielded({ requesterSessionKey, requesterAgentId: "main", requesterTurnRunId }),
  ).toBe(2);
  expect(
    settleRequesterAfterSessionSpawns({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
      requesterYielded: true,
      acceptedSessionSpawns: children,
    }),
  ).toBe(true);
  expect(
    markSubagentRunPausedAfterYield({
      entry: expectDefined(subagentRuns.get(previousRunId), "paused child"),
    }),
  ).toBe(true);
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
  const complete = async (runId: string, sessionKey: string, text: string) => {
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await fixture.settle();
  };
  await complete(siblingRunId, siblingSessionKey, "Sibling result is ready.");
  expectCompletedRun(siblingRunId, "Sibling result is ready.");
  expectSharedRequesterWake([previousRunId, siblingRunId], [previousRunId, siblingRunId]);
  expect(dispatch).not.toHaveBeenCalled();

  const followup = "Read the completed tool outputs and finish the existing task.";
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: nextRunId, status: "started" });
  });
  const sendResponse = vi.fn<RespondFn>();
  const send = () =>
    expectDefined(
      sessionMessagingHandlers["sessions.send"],
      "sessions.send",
    )({
      req: { type: "req", id: "resume-request", method: "sessions.send" },
      params: { key: childSessionKey, message: followup, idempotencyKey: nextRunId },
      respond: sendResponse,
      context,
      client: soloClient(),
      isWebchatConnect: () => false,
    });
  await send();
  expect(sendResponse).toHaveBeenCalledWith(
    true,
    { runId: nextRunId, status: "started" },
    undefined,
    undefined,
  );
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    runId: previousRunId,
    requesterSessionKey,
    childSessionKey,
    status: "running",
  });
  expect(findTaskByRunId(nextRunId)).toBeUndefined();
  expect(subagentRuns.has(previousRunId)).toBe(false);
  const resumed = expectDefined(subagentRuns.get(nextRunId), "resumed child");
  expect(resumed).toMatchObject({ task: followup, taskRunId: previousRunId, requesterSessionKey });
  expect(resumed.pauseReason).toBeUndefined();
  for (const runId of [nextRunId, siblingRunId]) {
    expect(subagentRuns.get(runId)?.requesterSettleWake).toMatchObject({
      batchRunIds: [nextRunId, siblingRunId].toSorted(),
      requesterYieldBatch: true,
      rearmGeneration: 1,
    });
  }

  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: nextRunId, status: "started" }, undefined, { cached: true });
  });
  await send();
  expect(subagentRuns.get(nextRunId)).toBe(resumed);

  await complete(nextRunId, childSessionKey, "Recovered child consumed its tool results.");
  expectCompletedRun(nextRunId, "Recovered child consumed its tool results.");
  const nextAttemptAt = expectSharedRequesterWake(
    [nextRunId, siblingRunId],
    [nextRunId, siblingRunId],
  );
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(Math.max(0, nextAttemptAt - Date.now()) + 1);
  await registryTesting.sweepOnceForTests();
  await fixture.settle();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
    sessionKey: requesterSessionKey,
    inputProvenance: { sourceTool: "subagent_settle" },
    message: expect.stringContaining("Recovered child consumed its tool results."),
  });
  expect(dispatch.mock.calls[0]?.[1]?.message).toContain("Sibling result is ready.");
  expect(getTaskById(originalTask.taskId)).toMatchObject({
    status: "succeeded",
    deliveryStatus: "delivered",
  });
  for (const runId of [nextRunId, siblingRunId]) {
    expect(subagentRuns.get(runId)?.requesterSettleWake).toBeUndefined();
  }
  expect(archiveRead).not.toHaveBeenCalled();
});
