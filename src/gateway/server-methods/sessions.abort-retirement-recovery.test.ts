// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { markStartupOrphanedMainSessionsForRecovery } from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { killAllControlledSubagentRuns } from "../../agents/subagents/registry/subagent-control-kill.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import * as registry from "../../agents/subagents/registry/subagent-registry.js";
import {
  markRequesterTurnYielded,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "../../infra/sqlite-worker-contract.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import * as lifecycleState from "../session-lifecycle-state.js";
import { createChatAbortContext } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

const fixture = useSubagentControlFixture();
const parentKey = "agent:main:dashboard:retirement-parent";
const parentId = "retirement-parent-session";
const parentRunId = "retirement-parent-run";
const childKey = "agent:main:subagent:retirement-child";
const childId = "retirement-child-session";
const childRunId = "retirement-child-run";

async function seedYieldedParent() {
  for (const [sessionKey, sessionId] of [
    [parentKey, parentId],
    [childKey, childId],
  ] as const) {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionId,
      lifecycleRevision: "original-incarnation",
    });
  }
  const startedAt = Date.now() - 100;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  for (const data of [
    { phase: "start", startedAt },
    {
      phase: "end",
      startedAt,
      endedAt: startedAt + 50,
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    },
  ]) {
    await persistGatewaySessionLifecycleEvent({
      sessionKey: parentKey,
      agentId: "main",
      event: { runId: parentRunId, sessionId: parentId, lifecycleGeneration, ts: Date.now(), data },
    });
  }
  await registerSubagentRun({
    runId: childRunId,
    childSessionKey: childKey,
    requesterSessionKey: parentKey,
    requesterAgentId: "main",
    requesterDisplayKey: parentKey,
    requesterTurnRunId: parentRunId,
    task: "Cancellation proof",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  expect(
    await markRequesterTurnYielded({
      requesterSessionKey: parentKey,
      requesterAgentId: "main",
      requesterTurnRunId: parentRunId,
    }),
  ).toBe(1);
  expect(
    await settleRequesterAfterSessionSpawns({
      requesterSessionKey: parentKey,
      requesterAgentId: "main",
      requesterTurnRunId: parentRunId,
      requesterYielded: true,
      acceptedSessionSpawns: [
        { runId: childRunId, childSessionKey: childKey, expectsCompletionMessage: true },
      ],
    }),
  ).toBe(true);
  expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toMatchObject({
    lifecycleRunId: parentRunId,
    endedAt: startedAt + 50,
    abortedLastRun: false,
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })?.status).toBeUndefined();
  expect((await getSubagentRunByChildSessionKey(childKey))?.requesterSettleWake).toMatchObject({
    requesterYieldBatch: true,
  });
}

async function completeChild() {
  // Only the external requester delivery is unavailable. Registry publication,
  // descendant traversal, parent persistence, and restart marking stay real.
  fixture.wake.mockResolvedValue(false);
  await seedYieldedParent();
  emitAgentEvent({
    runId: childRunId,
    sessionKey: childKey,
    sessionId: childId,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "Done" },
    },
  });
  await fixture.settle();
  expect(subagentRuns.get(childRunId)?.execution.outcome?.status).toBe("ok");
  expect(subagentRuns.get(childRunId)?.requesterSettleWake).toBeDefined();
}

async function stopParent() {
  const respond = vi.fn();
  await sessionAbortHandlers["sessions.abort"]!({
    req: { type: "req", id: "stop", method: "sessions.abort" },
    params: { key: parentKey, clearQueued: true },
    respond,
    context: createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    }) as never,
    client: {
      connId: "operator",
      connect: { scopes: ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0];
}

it("persists the yielded parent's cancellation after retiring a successful child's wake", async () => {
  await completeChild();
  expect((await stopParent())?.slice(0, 2)).toEqual([
    true,
    { ok: true, abortedRunId: null, status: "aborted" },
  ]);
  expect(subagentRuns.get(childRunId)?.execution.outcome?.status).toBe("ok");
  expect(subagentRuns.get(childRunId)?.requesterSettleWake).toBeUndefined();
  expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toMatchObject({
    status: "killed",
    abortedLastRun: true,
    lastRunId: parentRunId,
  });
  await fixture.settle();
  expect(
    await markStartupOrphanedMainSessionsForRecovery({
      cfg: getRuntimeConfig(),
      stateDir: fixture.stateDir,
    }),
  ).toMatchObject({ marked: 0 });
  const terminalParent = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
  expect((await stopParent())?.slice(0, 2)).toEqual([
    true,
    { ok: true, abortedRunId: null, status: "no-active-run" },
  ]);
  expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toEqual(terminalParent);
});

it("reports committed continuation retirement separately from killed executions", async () => {
  await completeChild();
  const stop = () =>
    killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller: {
        controllerSessionKey: parentKey,
        controllerAgentId: "main",
        callerSessionKey: parentKey,
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [subagentRuns.get(childRunId)!],
      suppressTaskDelivery: true,
    });
  expect(await stop()).toMatchObject({
    status: "ok",
    killed: 0,
    labels: [],
    continuationRetired: true,
  });
  expect(subagentRuns.get(childRunId)?.execution.outcome?.status).toBe("ok");
  expect(await stop()).toMatchObject({ status: "ok", killed: 0, labels: [] });
  expect(await stop()).not.toHaveProperty("continuationRetired");
});

it("does not retire a completed wake when the parent refuses Stop", async () => {
  await completeChild();
  const before = structuredClone(subagentRuns.get(childRunId));
  const result = await killAllControlledSubagentRuns({
    cfg: getRuntimeConfig(),
    controller: {
      controllerSessionKey: parentKey,
      controllerAgentId: "main",
      callerSessionKey: parentKey,
      callerIsSubagent: false,
      controlScope: "children",
    },
    runs: [subagentRuns.get(childRunId)!],
    suppressTaskDelivery: true,
    beforeKill: () => false,
  });
  expect(result).toMatchObject({ status: "ok", killed: 0, labels: [] });
  expect(result).not.toHaveProperty("continuationRetired");
  expect(subagentRuns.get(childRunId)).toEqual(before);
});

it("does not terminalize a parent whose pending final delivery owns its continuation", async () => {
  await completeChild();
  const target = { agentId: "main", sessionKey: parentKey };
  const before = loadSessionEntry(target)!;
  replaceSessionEntrySync(target, {
    ...before,
    pendingFinalDelivery: {
      kind: "replayable",
      text: "Final reply",
      intentId: "final-reply-intent",
      deliveries: [{ id: "final-reply-delivery", state: "prepared" }],
      createdAt: Date.now(),
    },
  });
  const pendingFinal = loadSessionEntry(target);
  expect((await stopParent())?.[0]).toBe(true);
  expect(loadSessionEntry(target)).toEqual(pendingFinal);
});

it("retains a replacement parent revision across the terminal write await", async () => {
  await completeChild();
  const target = { agentId: "main", sessionKey: parentKey };
  const replacement = { ...loadSessionEntry(target)!, lifecycleRevision: "replacement-revision" };
  const persist = lifecycleState.persistGatewaySessionLifecycleEvent;
  const gate = vi
    .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
    .mockImplementation(async (params) => {
      if (params.sessionKey === parentKey && params.expectedWriter) {
        replaceSessionEntrySync(target, replacement);
      }
      await persist(params);
    });
  try {
    expect((await stopParent())?.[0]).toBe(true);
    expect(loadSessionEntry(target)).toEqual(replacement);
    expect(subagentRuns.get(childRunId)?.execution.outcome?.status).toBe("ok");
  } finally {
    gate.mockRestore();
  }
});

it("does not acknowledge or replay an unknown parent persistence outcome", async () => {
  await completeChild();
  const before = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
  const persist = lifecycleState.persistGatewaySessionLifecycleEvent;
  const unknown = new SqliteWorkerError(
    "controlled parent write outcome unknown",
    "outcome-unknown",
  );
  // Controlled writer outcome; this does not claim a real lost SQLite reply.
  const gate = vi
    .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
    .mockImplementation(async (params) => {
      if (params.sessionKey === parentKey && params.expectedWriter) {
        throw unknown;
      }
      await persist(params);
    });
  try {
    const result = await stopParent().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(hasSqliteWorkerOutcomeUnknown(result)).toBe(true);
    expect(gate).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toEqual(before);
    expect(subagentRuns.get(childRunId)?.execution.outcome?.status).toBe("ok");
    expect(subagentRuns.get(childRunId)?.requesterSettleWake).toBeUndefined();
  } finally {
    gate.mockRestore();
  }
});

it("preserves a newer wake generation instead of reporting its retirement", async () => {
  await completeChild();
  const parentBefore = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
  const oldGeneration = subagentRuns.get(childRunId)!.requesterSettleWake!.rearmGeneration ?? 0;
  const cancel = registry.cancelSubagentRequesterSettleWake;
  const gate = vi
    .spyOn(registry, "cancelSubagentRequesterSettleWake")
    .mockImplementationOnce(async (entry, assertCurrent) => {
      await mutateSubagentRuns([entry.runId], (rows) => {
        const current = rows.get(entry.runId)!;
        const next = {
          ...current,
          requesterSettleWake: {
            ...current.requesterSettleWake!,
            rearmGeneration: oldGeneration + 1,
          },
        };
        return { value: undefined, postimages: new Map([[entry.runId, next]]) };
      });
      await cancel(entry, assertCurrent);
    });
  try {
    expect((await stopParent())?.[0]).toBe(false);
    expect(subagentRuns.get(childRunId)?.requesterSettleWake?.rearmGeneration).toBe(
      oldGeneration + 1,
    );
    expect(subagentRuns.get(childRunId)?.execution.outcome?.status).toBe("ok");
    expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toEqual(parentBefore);
  } finally {
    gate.mockRestore();
  }
});
