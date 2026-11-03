import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAdmittedRunActiveAssertion } from "../agents/admitted-run-context.js";
import { addSession, deleteSession, markExited } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import {
  maybeNotifyOnExit,
  prepareExecExitNotification,
} from "../agents/bash-tools.exec-notify.js";
import * as runs from "../agents/embedded-agent-runner/runs.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { CommandOwnerRevokedError } from "../auto-reply/command-owner-authority.js";
import { enqueueSessionEventForHost } from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import type { RespondFn } from "./server-methods/types.js";

export function registerGoalAutomaticContinuationCases(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.abort" | "sessions.goal.update",
    params: Record<string, unknown>,
  ) => Promise<MockInstance<RespondFn>>,
  goalStart: (message: string) => Record<string, unknown>,
  userMessages: () => readonly unknown[],
) {
  const result = (sessionId: string, aborted?: boolean) => ({
    payloads: aborted ? [] : [{ text: "More work remains." }],
    meta: {
      durationMs: 0,
      stopReason: aborted ? "aborted" : "end_turn",
      ...(aborted === undefined ? {} : { aborted }),
      agentMeta: { sessionId, provider: "test", model: "test", usage: { input: 1, output: 1 } },
    },
  });
  const expectDrained = async () =>
    expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
  const setGoalStatus = (status: "complete" | "paused") =>
    patchSessionEntryCore(scope(), (entry) => ({
      goal: entry.goal ? { ...entry.goal, status } : undefined,
    }));
  const start = async (message: string) =>
    expect((await rpc("chat.send", goalStart(message))).mock.calls[0]?.[0]).toBe(true);
  it("nudges consecutive normal final turns until the same Goal is complete", async () => {
    const completed = createDeferred();
    runEmbeddedAgent.mockImplementation(async (params) => {
      const calls = runEmbeddedAgent.mock.calls.length;
      if (calls === 3) {
        await setGoalStatus("complete");
        completed.resolve();
      }
      return result(params.sessionId);
    });
    await start("Finish a three-turn checklist");
    await completed.promise;
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain("Advance");
    expect(runEmbeddedAgent.mock.calls[2]?.[0].prompt).toContain("Advance");
    expect(userMessages()).toHaveLength(1);
    expect(loadSessionEntry(scope())?.goal).toMatchObject({
      status: "complete",
      continuationTurns: 2,
    });
  });

  // A background exec completion is admitted as a session-event turn. Its Goal
  // successor must outlive that event's occurrence, signal, and one-shot delivery,
  // while keeping an explicitly silent completion's delivery restriction.
  const completeExecDuringFirstTurn = (
    onEventTurn: () => Promise<void>,
    event: { deliver?: false } = {},
  ) => {
    const prompts: string[] = [];
    const delivery: Array<false | undefined> = [];
    runEmbeddedAgent.mockImplementation(async (params) => {
      prompts.push(params.prompt);
      delivery.push(getAgentRunContext(params.runId)?.sessionEventDelivery);
      if (runEmbeddedAgent.mock.calls.length === 1) {
        enqueueSessionEventForHost("Background exec completed", {
          ...scope(),
          ...event,
          source: "exec",
          sourceTurnId: "exec:goal-background",
        });
      } else if (runEmbeddedAgent.mock.calls.length >= 2) {
        await onEventTurn();
      }
      return result(params.sessionId);
    });
    return { prompts, delivery };
  };
  it.each([
    { name: "a background exec completion", event: {}, successorDelivery: undefined },
    {
      name: "an explicitly silent completion",
      event: { deliver: false },
      successorDelivery: false,
    },
  ] as const)("keeps pursuing after $name takes the next turn", async (testCase) => {
    const completed = createDeferred();
    const { prompts, delivery } = completeExecDuringFirstTurn(async () => {
      if (runEmbeddedAgent.mock.calls.length === 4) {
        await setGoalStatus("complete");
        completed.resolve();
      }
    }, testCase.event);
    await start("Finish after the transfer");
    await completed.promise;
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(4);
    expect(prompts[1]).toContain("Background exec completed");
    expect(prompts[2]).toContain("Advance");
    expect(prompts[3]).toContain("Advance");
    // Goal successors keep the completion's automatic-delivery restriction.
    expect(delivery).toEqual([
      undefined,
      testCase.successorDelivery,
      testCase.successorDelivery,
      testCase.successorDelivery,
    ]);
    expect(loadSessionEntry(scope())?.goal).toMatchObject({
      status: "complete",
      continuationTurns: 2,
    });
  });

  // The real exec producer captures its requester's command-owner check in the
  // completion target. Only "telegram:456" is a configured owner.
  const withOwnerPolicy = (revoke = false) => {
    const initial = getRuntimeConfig();
    const owners = revoke ? [] : ["456"];
    setRuntimeConfigSnapshot({
      ...initial,
      commands: { ...initial.commands, ownerAllowFrom: owners },
      channels: { ...initial.channels, telegram: {} },
    });
    return () => setRuntimeConfigSnapshot(initial);
  };
  const completeRequesterExec = async (senderId: string, silent = false) => {
    const { agentId, sessionKey } = scope();
    const id = `goal-${senderId}-${Date.now()}`;
    const process = createProcessSessionFixture({ id, backgrounded: true });
    Object.assign(process, { agentId, sessionKey, notifyOnExit: true });
    Object.assign(process, { notifyOnExitEmptySuccess: true });
    const requesterOrigin = { sessionKey, messageProvider: "telegram", senderId };
    const caller = { agentId, sessionKey, requesterOrigin };
    await withGatewayToolCallerIdentity(
      silent ? { ...caller, sessionEventDelivery: false as const } : caller,
      () => prepareExecExitNotification(process, false),
    );
    addSession(process);
    try {
      markExited(process, 0, null, "completed");
      await maybeNotifyOnExit(process, "completed", false);
    } finally {
      deleteSession(id);
    }
  };
  it.each([
    { name: "owner", senderId: "456", silent: false, owner: true },
    { name: "guest", senderId: "789", silent: false, owner: false },
    { name: "owner's silent", senderId: "456", silent: true, owner: true },
  ] as const)("keeps pursuing after an $name exec completion", async (testCase) => {
    const restore = withOwnerPolicy();
    const completed = createDeferred();
    const seen: Array<{ owner?: boolean; delivery?: false; prompt: string }> = [];
    runEmbeddedAgent.mockImplementation(async (params) => {
      const delivery = getAgentRunContext(params.runId)?.sessionEventDelivery;
      seen.push({ owner: params.senderIsOwner, delivery, prompt: params.prompt });
      if (seen.length === 1) {
        await completeRequesterExec(testCase.senderId, testCase.silent);
      } else if (seen.length === 4) {
        await setGoalStatus("complete");
        completed.resolve();
      }
      return result(params.sessionId);
    });
    try {
      await start("Finish after the owner's transfer");
      await completed.promise;
      await expectDrained();
    } finally {
      restore();
    }
    expect(seen[1]?.prompt).toContain("Exec completed");
    expect(seen.slice(2).map((turn) => turn.prompt)).toEqual([
      expect.stringContaining("Advance"),
      expect.stringContaining("Advance"),
    ]);
    // Successors keep only the requester's live owner check and the completion's delivery policy.
    const expected = { owner: testCase.owner, delivery: testCase.silent ? false : undefined };
    expect(seen.slice(1).map(({ owner, delivery }) => ({ owner, delivery }))).toEqual(
      Array.from({ length: 3 }, () => expected),
    );
  });

  it("stops an owner's Goal successor before execution once ownership is revoked", async () => {
    let restore = withOwnerPolicy();
    const owners: Array<boolean | undefined> = [];
    runEmbeddedAgent.mockImplementation(async (params) => {
      owners.push(params.senderIsOwner);
      if (owners.length === 1) {
        await completeRequesterExec("456");
      } else if (owners.length === 3) {
        // Revoked after the first successor ran; the next one must not execute.
        restore();
        restore = withOwnerPolicy(true);
      }
      return result(params.sessionId);
    });
    try {
      await start("Continue while the owner remains configured");
      await expectDrained();
    } finally {
      restore();
    }
    expect(owners.slice(1)).toEqual([true, true]);
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
    expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
  });

  it("refuses an admitted owner Goal successor's tool effect once ownership is revoked", async () => {
    let restore = withOwnerPolicy();
    const effects: string[] = [];
    let refusal: unknown;
    runEmbeddedAgent.mockImplementation(async (params) => {
      const calls = runEmbeddedAgent.mock.calls.length;
      if (calls === 1) {
        await completeRequesterExec("456");
      } else if (calls === 3) {
        expect(params).toMatchObject({
          senderIsOwner: true,
          prompt: expect.stringContaining("Advance"),
        });
        const admission = expectDefined(params.preparedRunAdmission, "successor admission");
        // The same assertion the runner hands its tools as `assertInvocationCurrent`.
        const assertTool = expectDefined(
          resolveAdmittedRunActiveAssertion(await admission.admit("embedded")),
          "admitted successor tool assertion",
        );
        const ownerEffect = (label: string) => {
          assertTool();
          effects.push(label);
        };
        ownerEffect("while owner");
        restore();
        restore = withOwnerPolicy(true);
        try {
          ownerEffect("after revocation");
        } catch (error) {
          refusal = error;
        }
      }
      return result(params.sessionId);
    });
    try {
      await start("Continue until ownership changes mid-turn");
      await expectDrained();
    } finally {
      restore();
    }
    expect(effects).toEqual(["while owner"]);
    // Refused at the admitted run's tool gate because the requester is no longer an owner.
    expect(refusal).toMatchObject({ cause: expect.any(CommandOwnerRevokedError) });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: "a background exec completion", event: {} },
    { name: "an explicitly silent completion", event: { deliver: false } },
  ] as const)("does not continue past a pause made during $name turn", async ({ event }) => {
    completeExecDuringFirstTurn(async () => {
      if (runEmbeddedAgent.mock.calls.length === 2) {
        await setGoalStatus("paused");
      }
    }, event);
    await start("Pause while the transfer reports");
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry(scope())?.goal?.status).toBe("paused");
  });

  it.each([
    { source: "a continuation", stopCall: 2, exec: false },
    { source: "an owner's silent exec completion successor", stopCall: 3, exec: true },
  ] as const)("stops automatic pursuit of $source and resumes the Goal once", async (testCase) => {
    const { sessionKey } = scope();
    const restore = testCase.exec ? withOwnerPolicy() : () => {};
    const secondStarted = createDeferred();
    const released = createDeferred();
    let continuationSignal: AbortSignal | undefined;
    let continuationRunId: string | undefined;
    runEmbeddedAgent.mockImplementation(async (params) => {
      const { sessionId: id, sessionFile: file, replyOperation: operation } = params;
      if (testCase.exec && runEmbeddedAgent.mock.calls.length === 1) {
        await completeRequesterExec("456", true);
      }
      if (runEmbeddedAgent.mock.calls.length === testCase.stopCall) {
        continuationRunId = params.runId;
        const runtimeAbort = new AbortController();
        continuationSignal = params.abortSignal
          ? AbortSignal.any([params.abortSignal, runtimeAbort.signal])
          : runtimeAbort.signal;
        const abort = () => {
          runtimeAbort.abort();
          released.resolve();
        };
        // The model is mocked; preserve the runtime's real Stop registration boundary.
        const backend = {
          kind: "embedded" as const,
          runId: params.runId,
          cancel: abort,
          abort,
          isStreaming: () => !runtimeAbort.signal.aborted,
          isAborted: () => runtimeAbort.signal.aborted,
          isCompacting: () => false,
          queueMessage: async () => {},
        };
        operation?.attachBackend(backend);
        runs.attachActiveEmbeddedRun(id, backend, sessionKey, file, "main", operation);
        secondStarted.resolve();
        try {
          await released.promise;
        } finally {
          runs.detachActiveEmbeddedRun(id, backend, sessionKey, file);
          operation?.detachBackend(backend);
        }
      }
      return result(id, continuationSignal?.aborted === true);
    });
    await start("Keep working until stopped");
    try {
      await secondStarted.promise;
      const stopped = await rpc("sessions.abort", { key: sessionKey, runId: continuationRunId });
      expect(stopped.mock.calls[0]?.[0]).toBe(true);
      expect(continuationSignal?.aborted).toBe(true);
    } finally {
      if (continuationSignal?.aborted !== true) {
        await setGoalStatus("paused");
      }
      released.resolve();
    }
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(testCase.stopCall);
    const stoppedEntry = loadSessionEntry(scope());
    expect(stoppedEntry?.goal?.status).toBe("active");
    expect(stoppedEntry?.abortedLastRun).toBe(true);
    const goal = stoppedEntry?.goal;
    const request = {
      sessionKey,
      sessionId: scope().sessionId,
      goalId: goal?.id,
      action: "resume",
      operationId: `resume-stopped-goal-${testCase.stopCall}`,
      issuedAtMs: Date.now(),
    };
    runEmbeddedAgent.mockImplementation(async (params) => {
      await setGoalStatus("complete");
      return result(params.sessionId);
    });
    const resumed = await rpc("sessions.goal.update", request);
    expect(resumed.mock.calls[0]).toEqual([
      true,
      expect.objectContaining({ status: "started", runId: request.operationId, goalId: goal?.id }),
      undefined,
      expect.anything(),
    ]);
    await expectDrained();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(testCase.stopCall + 1);
    expect(loadSessionEntry(scope())?.goal).toMatchObject({
      id: goal?.id,
      createdAt: goal?.createdAt,
      status: "complete",
    });
    const replay = await rpc("sessions.goal.update", request);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, runId: request.operationId });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(testCase.stopCall + 1);
    expect(userMessages()).toHaveLength(2);
    restore();
  });
}
