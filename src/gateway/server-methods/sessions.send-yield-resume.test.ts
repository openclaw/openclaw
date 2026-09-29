import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createRequesterYieldCallback } from "../../agents/openclaw-tools.requester-yield.js";
import { withLocalSessionPlacementTurnSettlement } from "../../agents/session-placement-admission.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "../../agents/subagents/announce/subagent-announce-overrides.test-support.js";
import { dispatchGatewayMethodInProcess } from "../../agents/subagents/announce/subagent-announce.runtime.js";
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "../../agents/subagents/registry/subagent-registry-run-pause.js";
import {
  persistSubagentRunsToDiskAsyncOrThrow,
  persistSubagentRunsToDiskOrThrow,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { observeRootWork } from "../../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { testing as registryTesting } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import * as requesterAuthority from "../../agents/subagents/requester-cron-authority.js";
import * as requesterAttachment from "../../agents/subagents/requester-final-attachment.js";
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as transcriptArchive from "../../config/sessions/session-accessor.sqlite-archive.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
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

it("resumes a yielded child through sessions.send and wakes its original parent after the same batch settles", async () => {
  vi.useFakeTimers();
  const realState = await vi.importActual<
    typeof import("../../agents/subagents/registry/subagent-registry-state.js")
  >("../../agents/subagents/registry/subagent-registry-state.js");
  vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
    realState.persistSubagentRunsToDiskAsyncOrThrow,
  );
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
  const dispatchEntered = createDeferred();
  const dispatch = vi.spyOn(delivery, "dispatch").mockImplementation(async () => {
    dispatchEntered.resolve();
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
  const runWorker = stateWorker.runOpenClawStateWorkerOperation;
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
  expect(
    markSubagentRunPausedAfterYield({
      entry: expectDefined(subagentRuns.get(previousRunId), "paused child"),
    }),
  ).toBe(true);
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
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
  const settleWakeWork = observeRootWork();
  await vi.advanceTimersByTimeAsync(Math.max(0, nextAttemptAt - Date.now()) + 1);
  await registryTesting.sweepOnceForTests();
  await dispatchEntered.promise;
  await settleWakeWork();
  await fixture.settle();
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

it.each([
  { retirement: "runtime owner", repetition: "intent" },
  { retirement: "runtime owner", repetition: "cohort" },
  { retirement: "state source", repetition: "intent" },
  { retirement: "state source", repetition: "cohort" },
] as const)(
  "retains the committed outcome after $retirement replacement for a repeated $repetition claim",
  async ({ retirement, repetition }) => {
    const requesterSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:initial-retirement";
    const runId = "initial-retirement-child";
    const requesterTurnRunId = "initial-retirement-parent";
    await registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
      requesterDisplayKey: requesterSessionKey,
      task: "Keep the original requester owner",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const entry = expectDefined(subagentRuns.get(runId), "original initial child");
    const execution = entry.execution;
    const nativeState = await vi.importActual<
      typeof import("../../agents/subagents/registry/subagent-registry-state.js")
    >("../../agents/subagents/registry/subagent-registry-state.js");
    const acknowledged = createDeferred();
    const releaseAcknowledgement = createDeferred();
    let committed = false;
    let writes = 0;
    let closing: Promise<void> | undefined;
    vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      nativeState.persistSubagentRunsToDiskAsyncOrThrow,
    );
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
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
                    entry.execution = { ...execution };
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
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "initial-retirement-session",
      claimYield: createRequesterYieldCallback({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
      }),
      onYield,
    });
    const first = tool.execute("yield-retired-owner", {}).then(
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
      expect({
        ...outcome,
        committed,
        liveIsCaptured: subagentRuns.get(runId) === entry,
        sameExecution: entry.execution === execution,
        yielded: entry.requesterTurnYielded,
      }).toMatchObject({
        error: { outcome: "committed", publication: "superseded" },
      });
      expect(committed).toBe(true);
      await closing;
      repeated ??= repeatClaim();
      const repeatedOutcome = await repeated.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect({ ...repeatedOutcome, writes, yields: onYield.mock.calls.length }).toMatchObject({
        error: { outcome: "committed", publication: "superseded" },
        writes: 1,
        yields: 0,
      });
      expect(writes).toBe(1);
      expect(onYield).not.toHaveBeenCalled();
      expect(entry.requesterTurnYielded).toBeUndefined();
      if (retirement === "runtime owner") {
        expect(entry.execution).toEqual(execution);
        expect(entry.execution).not.toBe(execution);
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

it("retains an unknown initial intent until canonical worker restore reconciles the committed row", async () => {
  const requesterSessionKey = "agent:main:main";
  const requesterTurnRunId = "unknown-initial-parent";
  const runId = "unknown-initial-child";
  await registerSubagentRun({
    runId,
    childSessionKey: "agent:main:subagent:unknown-initial-child",
    requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId,
    requesterDisplayKey: requesterSessionKey,
    task: "Retain an unacknowledged initial intent",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  const entry = expectDefined(subagentRuns.get(runId), "original uncertain child");
  const nativeState = await vi.importActual<
    typeof import("../../agents/subagents/registry/subagent-registry-state.js")
  >("../../agents/subagents/registry/subagent-registry-state.js");
  vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
    nativeState.persistSubagentRunsToDiskAsyncOrThrow,
  );
  const runWorker = stateWorker.runOpenClawStateWorkerOperation;
  let writes = 0;
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
                throw new SqliteWorkerError("Initial acknowledgement lost", "outcome-unknown");
              }
              return result;
            },
          }),
        options,
      ),
    );
  const onYield = vi.fn();
  const tool = createSessionsYieldTool({
    sessionId: "unknown-initial-session",
    claimYield: createRequesterYieldCallback({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
    }),
    onYield,
  });
  try {
    await expect(tool.execute("yield-unknown", {})).rejects.toMatchObject({ outcome: "unknown" });
    expect(onYield).not.toHaveBeenCalled();
    expect(entry.requesterTurnYielded).toBeUndefined();
    expect(() => persistSubagentRunsToDiskOrThrow(subagentRuns, [runId])).toThrow();
    expect(writes).toBe(1);
  } finally {
    worker.mockRestore();
    await closeOpenClawStateDatabaseAsync();
  }
  const restoredSql = observeParentSqlite();
  try {
    await nativeState.restoreSubagentRunsFromDisk({ runs: subagentRuns });
  } finally {
    restoredSql.restore();
  }
  expect(restoredSql.counts).toEqual(emptySqliteCounts());
  expect(subagentRuns.get(runId)).not.toBe(entry);
  expect(subagentRuns.get(runId)).toMatchObject({ requesterTurnYielded: true, requesterTurnRunId });
  expect(onYield).not.toHaveBeenCalled();
});

it.each([false, true])(
  "joins a concurrent yield claim until host handoff (joining caller retired: %s)",
  async (retired) => {
    vi.useFakeTimers();
    const requesterSessionKey = "agent:main:main";
    const requesterTurnRunId = "joined-initial-parent";
    const runId = "joined-initial-child";
    await registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:joined-initial-child",
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
      requesterDisplayKey: requesterSessionKey,
      task: "Join the original initial handoff",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const nativeState = await vi.importActual<
      typeof import("../../agents/subagents/registry/subagent-registry-state.js")
    >("../../agents/subagents/registry/subagent-registry-state.js");
    vi.mocked(persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      nativeState.persistSubagentRunsToDiskAsyncOrThrow,
    );
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
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
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
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "joined-initial-session",
      claimYield: createRequesterYieldCallback({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
      }),
      onYield,
    });
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
