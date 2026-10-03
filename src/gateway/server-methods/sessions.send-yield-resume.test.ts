// Preserve native worker fixture mocks before production consumers load the registry.
// oxfmt-ignore
import {
  runSubagentStateWorkerOperation,
  useSubagentControlFixture,
} from "../../agents/subagents/registry/subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createRequesterYieldCallback } from "../../agents/openclaw-tools.requester-yield.js";
import { withLocalSessionPlacementTurnSettlement } from "../../agents/session-placement-admission.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "../../agents/subagents/announce/subagent-announce-overrides.test-support.js";
import { dispatchGatewayMethodInProcess } from "../../agents/subagents/announce/subagent-announce.runtime.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "../../agents/subagents/registry/subagent-registry-run-pause.js";
import { observeRootWork } from "../../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  markSubagentMessageWait,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import * as requesterAuthority from "../../agents/subagents/requester-cron-authority.js";
import * as requesterAttachment from "../../agents/subagents/requester-final-attachment.js";
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as transcriptArchive from "../../config/sessions/session-accessor.sqlite-archive.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { readOperatorToolGatewayAuthority } from "../operator-tool-gateway-authority.js";
import { withRequesterTestAuthority } from "./sessions-initial-transfer.test-support.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import { sessionSharingTestContext, soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

const chatSend = vi.hoisted(() => vi.fn<GatewayRequestHandler>());
vi.mock("./chat-send-external-entry.js", () => ({ handleDirectExternalChatSend: chatSend }));

const fixture = useSubagentControlFixture();
afterEach(() => {
  requesterAuthority.revokeRequesterCronAuthority("agent:main:main");
  setSubagentAnnounceDeliveryDepsForTest();
  vi.useRealTimers();
});

async function createInitialYieldFixture(label: string) {
  const requesterSessionKey = "agent:main:main";
  const requesterTurnRunId = `${label}-parent`;
  const runId = `${label}-child`;
  const childSessionKey = `agent:main:subagent:${runId}`;
  await registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId,
    requesterDisplayKey: requesterSessionKey,
    task: "Finish the initial requester handoff",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  const onYield = vi.fn();
  const tool = createSessionsYieldTool({
    sessionId: `${label}-session`,
    claimYield: createRequesterYieldCallback({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
    }),
    onYield,
  });
  return {
    requesterSessionKey,
    requesterTurnRunId,
    runId,
    childSessionKey,
    entry: expectDefined(subagentRuns.get(runId), "initial child"),
    onYield,
    tool,
  };
}

it("resumes a yielded child through sessions.send and wakes its original parent after the same batch settles", async () => {
  vi.useFakeTimers();
  const { runSubagentAnnounceFlow } = await vi.importActual<
    typeof import("../../agents/subagents/announce/subagent-announce.js")
  >("../../agents/subagents/announce/subagent-announce.js");
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
    expect(entry).toMatchObject({
      execution: { status: "terminal", outcome: { status: "ok" } },
      completion: { resultText },
      cleanupCompletedAt: expect.any(Number),
    });
  };
  const expectSharedRequesterCohort = (runIds: string[], batchRunIds: string[]) => {
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
    return wakes;
  };
  const context = sessionSharingTestContext(vi.fn(), getRuntimeConfig());
  context.resolveGatewayContext = () => context;
  const delivery = { dispatch: dispatchGatewayMethodInProcess };
  const dispatch = vi.spyOn(delivery, "dispatch").mockImplementation(async () => {
    return {
      status: "ok",
      result: { payloads: [{ text: "Both results received; parent continues." }], meta: {} },
    };
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
    await registerSubagentRun({
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
  const onYield = vi.fn(() => {
    for (const child of children) {
      expect(subagentRuns.get(child.runId)?.requesterTurnYielded).toBe(true);
    }
  });
  const yieldTool = createSessionsYieldTool({
    sessionId: `${requesterSessionKey}-session`,
    claimYield: createRequesterYieldCallback({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
    }),
    onYield,
  });
  const acknowledgedIntent = createDeferred();
  const releaseIntent = createDeferred();
  const runWorker = runSubagentStateWorkerOperation;
  let registryWrites = 0;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((stateContext, operation, options) =>
      runWorker(
        stateContext,
        (scope) =>
          operation({
            ...scope,
            execute: async (...args) => {
              const result = await scope.execute(...args);
              if (args[0].type === "subagents.persistChanges" && ++registryWrites === 1) {
                acknowledgedIntent.resolve();
                await releaseIntent.promise;
              }
              return result;
            },
          }),
        options,
      ),
    );
  const failedPromotion = createDeferred();
  const promotion = vi
    .spyOn(requesterAttachment, "promoteRequesterFinalAttachment")
    .mockImplementationOnce(() => {
      failedPromotion.resolve();
      throw new Error("promotion callback interrupted");
    });
  const hostSql = observeParentSqlite();
  try {
    await withRequesterTestAuthority(requesterTurnRunId, requesterSessionKey, async () => {
      const yielding = yieldTool.execute("yield-parent", {});
      await Promise.race([
        acknowledgedIntent.promise,
        yielding.then(() => {
          throw new Error("Yield completed before the native acknowledgement handoff");
        }),
      ]);
      expect(onYield).not.toHaveBeenCalled();
      expect(children.map((child) => subagentRuns.get(child.runId)?.requesterTurnYielded)).toEqual([
        undefined,
        undefined,
      ]);
      releaseIntent.resolve();
      await expect(yielding).resolves.toMatchObject({
        details: { status: "yielded" },
      });
      let settled = false;
      const settlement = withLocalSessionPlacementTurnSettlement(
        {
          sessionId: `${requesterSessionKey}-session`,
          sessionKey: requesterSessionKey,
          agentId: "main",
          runId: requesterTurnRunId,
        },
        async () => ({
          acceptedSessionSpawns: children,
          meta: {
            durationMs: 1,
            yielded: true,
            executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
          },
        }),
        {},
      ).then((result) => {
        settled = true;
        return result;
      });
      await Promise.race([
        failedPromotion.promise,
        settlement.then(() => {
          throw new Error("Settlement skipped initial authority promotion");
        }),
      ]);
      expect(settled).toBe(false);
      expect(registryWrites).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await settlement;
      expect(result.requesterContinuationSettled).toBe(true);
      expect(registryWrites).toBe(3);
    });
  } finally {
    releaseIntent.resolve();
    hostSql.restore();
    worker.mockRestore();
    promotion.mockRestore();
  }
  expect(onYield).toHaveBeenCalledOnce();
  await mutateSubagentRuns([previousRunId], (rows) => {
    const next = structuredClone(expectDefined(rows.get(previousRunId), "paused child"));
    expect(markSubagentRunPausedAfterYield({ entry: next })).toBe(true);
    return { value: undefined, postimages: new Map([[next.runId, next]]) };
  });
  const complete = async (runId: string, sessionKey: string, text: string) => {
    const announceEntered = createDeferred();
    fixture.announce.mockImplementationOnce((params) => {
      announceEntered.resolve();
      return runSubagentAnnounceFlow(params);
    });
    const settleRootWork = observeRootWork();
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
    await announceEntered.promise;
    await settleRootWork();
    await fixture.settle();
  };
  await complete(siblingRunId, siblingSessionKey, "Sibling result is ready.");
  expectCompletedRun(siblingRunId, "Sibling result is ready.");
  const pausedCohort = expectSharedRequesterCohort(
    [previousRunId, siblingRunId],
    [previousRunId, siblingRunId],
  );
  expect(pausedCohort.map((wake) => wake?.nextAttemptAt)).toEqual([undefined, undefined]);
  expect(pausedCohort.map((wake) => wake?.status)).toEqual(["pending", "pending"]);
  expect(pausedCohort[0]?.pauseNotice).toBeUndefined();
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
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
    sessionKey: requesterSessionKey,
    inputProvenance: { sourceTool: "subagent_settle" },
    message: expect.stringContaining("Recovered child consumed its tool results."),
  });
  expect(dispatch.mock.calls[0]?.[1]?.message).toContain("Sibling result is ready.");
  for (const runId of [nextRunId, siblingRunId]) {
    expect(subagentRuns.get(runId)?.requesterSettleWake).toBeUndefined();
  }
  expect(archiveRead).not.toHaveBeenCalled();
  expect(hostSql.counts).toEqual(emptySqliteCounts());
});

it("delivers a completed sibling while a batch member waits for its requester's continuation", async () => {
  vi.useFakeTimers();
  const { runSubagentAnnounceFlow } = await vi.importActual<
    typeof import("../../agents/subagents/announce/subagent-announce.js")
  >("../../agents/subagents/announce/subagent-announce.js");
  const requesterSessionKey = "agent:main:main";
  const waitingSessionKey = "agent:main:subagent:waiting-child";
  const siblingSessionKey = "agent:main:subagent:finishing-sibling";
  const waitingRunId = "waiting-child-run";
  const resumedRunId = "resumed-waiting-child-run";
  const siblingRunId = "finishing-sibling-run";
  const requesterTurnRunId = "parent-turn";
  const context = sessionSharingTestContext(vi.fn(), getRuntimeConfig());
  context.resolveGatewayContext = () => context;
  // The yield captures the requester's operator; every split wave must still carry it.
  const operator = createAdmittedRunOperatorAuthority({
    profileId: "split-batch-operator",
    scopes: ["operator.read"],
    assertCurrent: () => {},
  });
  const dispatchOperators: unknown[] = [];
  const delivery = { dispatch: dispatchGatewayMethodInProcess };
  const dispatch = vi.spyOn(delivery, "dispatch").mockImplementation(async () => {
    dispatchOperators.push(readOperatorToolGatewayAuthority()?.operatorRunAuthority);
    return {
      status: "ok",
      result: { payloads: [{ text: "Parent handled the update." }], meta: {} },
    };
  });
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: delivery.dispatch });
  const dispatchedMessage = (index: number) => String(dispatch.mock.calls[index]?.[1]?.message);

  for (const sessionKey of [requesterSessionKey, waitingSessionKey, siblingSessionKey]) {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: `${sessionKey}-session`,
    });
  }
  const children = [
    { runId: waitingRunId, childSessionKey: waitingSessionKey, expectsCompletionMessage: true },
    { runId: siblingRunId, childSessionKey: siblingSessionKey, expectsCompletionMessage: true },
  ];
  for (const child of children) {
    await registerSubagentRun({
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
  const yieldTool = createSessionsYieldTool({
    sessionId: `${requesterSessionKey}-session`,
    claimYield: createRequesterYieldCallback({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
    }),
    onYield: vi.fn(),
  });
  await withRequesterTestAuthority(
    requesterTurnRunId,
    requesterSessionKey,
    async () => {
      await expect(yieldTool.execute("yield-parent", {})).resolves.toMatchObject({
        details: { status: "yielded" },
      });
      const settlement = withLocalSessionPlacementTurnSettlement(
        {
          sessionId: `${requesterSessionKey}-session`,
          sessionKey: requesterSessionKey,
          agentId: "main",
          runId: requesterTurnRunId,
        },
        async () => ({
          acceptedSessionSpawns: children,
          meta: {
            durationMs: 1,
            yielded: true,
            executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
          },
        }),
        {},
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(settlement).resolves.toMatchObject({ requesterContinuationSettled: true });
    },
    operator,
  );
  for (const runId of [waitingRunId, siblingRunId]) {
    expect(subagentRuns.get(runId)?.requesterSettleWake).toMatchObject({
      batchRunIds: [waitingRunId, siblingRunId].toSorted(),
      requesterYieldBatch: true,
      rearmGeneration: 1,
    });
  }

  const endRun = async (runId: string, sessionKey: string, data: Record<string, unknown>) => {
    const settleRootWork = observeRootWork();
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase: "end", endedAt: Date.now(), ...data },
    });
    await settleRootWork();
    await fixture.settle();
  };
  const complete = async (runId: string, sessionKey: string, text: string) => {
    const announceEntered = createDeferred();
    fixture.announce.mockImplementationOnce((params) => {
      announceEntered.resolve();
      return runSubagentAnnounceFlow(params);
    });
    const ended = endRun(runId, sessionKey, {
      terminalReply: { disposition: "visible", text },
    });
    await announceEntered.promise;
    await ended;
  };

  // The child asks its requester for direction. Once that notice is delivered, the
  // requester owns the continuation, so the child no longer holds its sibling's result.
  await expect(
    markSubagentMessageWait({
      runId: waitingRunId,
      sessionKey: waitingSessionKey,
      acknowledgment: "WAITING-MARKER: send the sibling's result before I continue.",
    }),
  ).resolves.toBe(true);
  await endRun(waitingRunId, waitingSessionKey, { yielded: true });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatchedMessage(0)).toContain('"state":"paused"');
  expect(dispatchedMessage(0)).toContain("WAITING-MARKER");
  const waiting = expectDefined(subagentRuns.get(waitingRunId), "waiting child");
  expect(waiting.pauseReason).toBe("sessions_yield");
  expect(waiting.requesterSettleWake?.status).toBe("pending");
  expect(waiting.requesterSettleWake?.pauseNotice).toBeUndefined();

  await complete(siblingRunId, siblingSessionKey, "SIBLING-MARKER: result is ready.");
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls[1]?.[1]).toMatchObject({
    sessionKey: requesterSessionKey,
    inputProvenance: { sourceTool: "subagent_settle" },
  });
  expect(dispatchedMessage(1)).toContain("SIBLING-MARKER: result is ready.");
  expect(dispatchedMessage(1)).not.toContain("WAITING-MARKER");
  expect(subagentRuns.get(siblingRunId)?.requesterSettleWake).toBeUndefined();
  expect(subagentRuns.get(waitingRunId)).toMatchObject({
    pauseReason: "sessions_yield",
    requesterSettleWake: {
      status: "pending",
      batchRunIds: [waitingRunId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  });

  // The requester's continuation resumes the same task, whose result still arrives.
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: resumedRunId, status: "started" });
  });
  const sendResponse = vi.fn<RespondFn>();
  await expectDefined(
    sessionMessagingHandlers["sessions.send"],
    "sessions.send",
  )({
    req: { type: "req", id: "resume-request", method: "sessions.send" },
    params: {
      key: waitingSessionKey,
      message: "Here is the sibling's result; finish the task.",
      idempotencyKey: resumedRunId,
    },
    respond: sendResponse,
    context,
    client: soloClient(),
    isWebchatConnect: () => false,
  });
  expect(sendResponse).toHaveBeenCalledWith(
    true,
    { runId: resumedRunId, status: "started" },
    undefined,
    undefined,
  );
  expect(subagentRuns.get(resumedRunId)?.requesterSettleWake).toMatchObject({
    batchRunIds: [resumedRunId],
    requesterYieldBatch: true,
    rearmGeneration: 1,
  });
  await complete(resumedRunId, waitingSessionKey, "RESUMED-MARKER: continued task finished.");
  expect(dispatch).toHaveBeenCalledTimes(3);
  expect(dispatchedMessage(2)).toContain("RESUMED-MARKER: continued task finished.");
  expect(dispatchedMessage(2)).not.toContain("SIBLING-MARKER");
  expect(subagentRuns.get(resumedRunId)?.requesterSettleWake).toBeUndefined();
  expect(dispatchOperators).toHaveLength(3);
  for (const dispatchOperator of dispatchOperators) {
    expect(dispatchOperator).toBe(operator);
  }
});

it.each([
  { retirement: "runtime owner", repetition: "intent" },
  { retirement: "runtime owner", repetition: "cohort" },
  { retirement: "state source", repetition: "intent" },
  { retirement: "state source", repetition: "cohort" },
] as const)(
  "retains the committed outcome after $retirement replacement for a repeated $repetition claim",
  async ({ retirement, repetition }) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: "agent:main:main",
      defaultSessionId: "agent:main:main-session",
    });
    const {
      requesterSessionKey,
      requesterTurnRunId,
      runId,
      childSessionKey,
      entry,
      onYield,
      tool,
    } = await createInitialYieldFixture("initial-retirement");
    let retireRequester = () => {};
    const acknowledged = createDeferred();
    const releaseAcknowledgement = createDeferred();
    let committed = false;
    let writes = 0;
    let closing: Promise<void> | undefined;
    const runWorker = runSubagentStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((stateContext, operation, options) =>
        runWorker(
          stateContext,
          (scope) =>
            operation({
              ...scope,
              execute: async (...args) => {
                const result = await scope.execute(...args);
                if (args[0].type === "subagents.persistChanges") {
                  writes += 1;
                }
                if (!committed && args[0].type === "subagents.persistChanges") {
                  committed = true;
                  if (retirement === "runtime owner") {
                    retireRequester();
                  } else {
                    closing = closeOpenClawStateDatabaseAsync();
                  }
                  acknowledged.resolve();
                  await releaseAcknowledgement.promise;
                }
                return result;
              },
            }),
          options,
        ),
      );
    const first = withRequesterTestAuthority(
      requesterTurnRunId,
      requesterSessionKey,
      async (retire) => {
        retireRequester = retire;
        return await tool.execute("yield-retired-owner", {});
      },
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const repeatClaim = () =>
      repetition === "intent"
        ? tool.execute("yield-repeated-retired-owner", {})
        : settleRequesterAfterSessionSpawns({
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
            requesterYielded: false,
            acceptedSessionSpawns: [{ runId, childSessionKey, expectsCompletionMessage: true }],
          });
    let repeated: ReturnType<typeof repeatClaim> | undefined;
    try {
      await Promise.race([
        acknowledged.promise,
        first.then(() => {
          throw new Error("Initial write did not reach its held native acknowledgement");
        }),
      ]);
      if (retirement === "runtime owner") {
        repeated = repeatClaim();
        void repeated.catch(() => {});
        await vi.dynamicImportSettled();
      }
      releaseAcknowledgement.resolve();
      const outcome = await first;
      expect(outcome).toMatchObject({
        error:
          retirement === "runtime owner"
            ? { outcome: "committed", publication: "published" }
            : { outcome: "committed", publication: "superseded" },
      });
      expect(committed).toBe(true);
      await closing;
      repeated ??= repeatClaim();
      const repeatedOutcome = await repeated.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect(repeatedOutcome).toMatchObject({
        error:
          retirement === "runtime owner"
            ? { outcome: "committed", publication: "published" }
            : { outcome: "committed", publication: "superseded" },
      });
      expect(writes).toBe(1);
      expect(onYield).not.toHaveBeenCalled();
      expect(entry.requesterTurnYielded).toBeUndefined();
      if (retirement === "runtime owner") {
        expect(subagentRuns.get(runId)?.requesterTurnYielded).toBe(true);
      }
    } finally {
      releaseAcknowledgement.resolve();
      await Promise.allSettled([first, ...(repeated ? [repeated] : [])]);
      await closing;
      worker.mockRestore();
    }
    const { loadSubagentRegistryFromSqlite } = await vi.importActual<
      typeof import("../../agents/subagents/registry/subagent-registry.store.sqlite.js")
    >("../../agents/subagents/registry/subagent-registry.store.sqlite.js");
    expect(loadSubagentRegistryFromSqlite().get(runId)?.requesterTurnYielded).toBe(true);
  },
);

it("retains an unknown initial intent until canonical worker restore reconciles the row", async () => {
  const { requesterTurnRunId, runId, entry, onYield, tool } =
    await createInitialYieldFixture("unknown-initial");
  const nativePersistence = await vi.importActual<
    typeof import("../../agents/subagents/registry/subagent-registry-persistence.js")
  >("../../agents/subagents/registry/subagent-registry-persistence.js");
  let writes = 0;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async () => {
      writes += 1;
      throw new SqliteWorkerError("Initial write outcome unavailable", "outcome-unknown");
    });
  try {
    await expect(tool.execute("yield-unknown", {})).rejects.toMatchObject({ outcome: "unknown" });
    expect(onYield).not.toHaveBeenCalled();
    expect(entry.requesterTurnYielded).toBeUndefined();
    await expect(mutateSubagentRuns([runId], () => ({ value: undefined }))).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(writes).toBe(1);
  } finally {
    worker.mockRestore();
    await closeOpenClawStateDatabaseAsync();
  }
  const restoredSql = observeParentSqlite();
  try {
    await nativePersistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
  } finally {
    restoredSql.restore();
  }
  expect(restoredSql.counts).toEqual(emptySqliteCounts());
  expect(subagentRuns.get(runId)).not.toBe(entry);
  expect(subagentRuns.get(runId)).toMatchObject({ requesterTurnRunId });
  expect(subagentRuns.get(runId)?.requesterTurnYielded).toBeUndefined();
  expect(onYield).not.toHaveBeenCalled();
});

it.each([false, true])(
  "joins a concurrent yield claim until host handoff (joining caller retired: %s)",
  async (retired) => {
    vi.useFakeTimers();
    const { requesterSessionKey, requesterTurnRunId, runId, onYield, tool } =
      await createInitialYieldFixture("joined-initial");
    const handoffFailed = createDeferred();
    const commit = vi
      .fn()
      .mockImplementationOnce(() => {
        handoffFailed.resolve();
        throw new Error("initial authority handoff interrupted");
      })
      .mockImplementation(() => {});
    const bind = vi.fn().mockResolvedValue({
      commit,
      revoke: vi.fn(),
    });
    const capture = vi
      .spyOn(requesterAuthority, "prepareRequesterCronAuthority")
      .mockImplementation(() => ({
        assertCurrent: vi.fn(),
        validate: vi.fn().mockResolvedValue(undefined),
        bind,
        release: vi.fn().mockResolvedValue(undefined),
      }));
    let writes = 0;
    const runWorker = runSubagentStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        runWorker(
          context,
          (scope) =>
            operation({
              ...scope,
              execute: (...args) => {
                if (args[0].type === "subagents.persistChanges") {
                  writes += 1;
                }
                return scope.execute(...args);
              },
            }),
          options,
        ),
      );
    const first = tool.execute("yield-first", {});
    let second: ReturnType<typeof tool.execute> | undefined;
    try {
      await Promise.race([
        handoffFailed.promise,
        first.then(() => {
          throw new Error("Initial yield skipped the held handoff");
        }),
      ]);
      expect(subagentRuns.get(runId)?.requesterTurnYielded).toBe(true);
      expect(onYield).not.toHaveBeenCalled();
      const joined = createDeferred();
      second = withRequesterTestAuthority(
        requesterTurnRunId,
        requesterSessionKey,
        async (retire) => {
          const claim = tool.execute("yield-concurrent", {});
          void claim.catch(() => {});
          await vi.advanceTimersByTimeAsync(0);
          if (retired) {
            retire();
          }
          joined.resolve();
          return await claim;
        },
      );
      void second.catch(() => {});
      await joined.promise;
      expect(onYield).not.toHaveBeenCalled();
      expect(writes).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(first).resolves.toMatchObject({ details: { status: "yielded" } });
      if (retired) {
        await expect(second).rejects.toMatchObject({ outcome: "committed" });
      } else {
        await expect(second).resolves.toMatchObject({ details: { status: "yielded" } });
      }
      expect(onYield).toHaveBeenCalledTimes(retired ? 1 : 2);
      expect(commit).toHaveBeenCalledTimes(2);
      expect(bind).toHaveBeenCalledOnce();
      expect(writes).toBe(1);
    } finally {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      worker.mockRestore();
      capture.mockRestore();
    }
  },
);
