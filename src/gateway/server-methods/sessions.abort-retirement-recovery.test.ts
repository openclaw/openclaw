// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { beforeEach, expect, it, vi } from "vitest";
import { markStartupOrphanedMainSessionsForRecovery } from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { killAllControlledSubagentRuns } from "../../agents/subagents/registry/subagent-control-kill.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import * as registry from "../../agents/subagents/registry/subagent-registry.js";
import { writeChildSession } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "../../infra/sqlite-worker-contract.js";
import * as lifecycleState from "../session-lifecycle-state.js";
import {
  abortContext,
  expectCancelledSession,
  registerYieldedChild,
  seedYieldedSession,
  stopSession,
} from "./sessions.abort-lifecycle.test-support.js";

const fixture = useSubagentControlFixture();

const parentKey = "agent:main:dashboard:retirement-parent";
const parentId = "retirement-parent-session";
const parentRunId = "retirement-parent-run";
const childKey = "agent:main:subagent:retirement-child";
const childId = "retirement-child-session";
const childRunId = "retirement-child-run";
const target = { agentId: "main", sessionKey: parentKey };
const parent = () => loadSessionEntry(target);
const child = () => subagentRuns.get(childRunId);

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
  // Only external requester delivery is unavailable; registry and persistence stay real.
  fixture.wake.mockResolvedValue(false);
  await writeChildSession(fixture.stateDir, childKey, childId, "original-incarnation");
  const startedAt = await seedYieldedSession(fixture.stateDir, parentKey, parentId, parentRunId);
  await registerYieldedChild({
    parentKey,
    parentRunId,
    childKey,
    childRunId,
    startedAt,
    sessionEntry: { sessionId: childId, lifecycleRevision: "original-incarnation" },
  });
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
  expect(child()?.execution.outcome?.status).toBe("ok");
  expect(child()?.requesterSettleWake).toBeDefined();
});

async function stopParent() {
  const respond = vi.fn();
  await stopSession(parentKey, respond, abortContext(), { clearQueued: true });
  return respond.mock.calls[0];
}

function expectStop(status = "aborted") {
  return stopParent().then((response) => {
    expect(response?.slice(0, 2)).toEqual([true, { ok: true, abortedRunId: null, status }]);
  });
}

async function expectRetiredParent() {
  expect(child()?.execution.outcome?.status).toBe("ok");
  expect(child()?.requesterSettleWake).toBeUndefined();
  expectCancelledSession(parent(), parentRunId);
  await fixture.settle();
  expect(
    await markStartupOrphanedMainSessionsForRecovery({
      cfg: getRuntimeConfig(),
      stateDir: fixture.stateDir,
    }),
  ).toMatchObject({ marked: 0 });
}

function killChildren(beforeKill?: () => boolean) {
  return killAllControlledSubagentRuns({
    cfg: getRuntimeConfig(),
    controller: {
      controllerSessionKey: parentKey,
      controllerAgentId: "main",
      callerSessionKey: parentKey,
      callerIsSubagent: false,
      controlScope: "children",
    },
    runs: [child()!],
    suppressTaskDelivery: true,
    beforeKill,
  });
}

it("persists the yielded parent's cancellation after retiring a successful child's wake", async () => {
  await expectStop();
  await expectRetiredParent();
  const terminalParent = parent();
  await expectStop("no-active-run");
  expect(parent()).toEqual(terminalParent);
});

it("reports committed continuation retirement separately from killed executions", async () => {
  expect(await killChildren()).toMatchObject({
    status: "ok",
    killed: 0,
    labels: [],
    continuationRetired: true,
  });
  expect(child()?.execution.outcome?.status).toBe("ok");
  expect(await killChildren()).toMatchObject({ status: "ok", killed: 0, labels: [] });
  expect(await killChildren()).not.toHaveProperty("continuationRetired");
});

it("does not retire a completed wake when the parent refuses Stop", async () => {
  const before = structuredClone(child());
  const result = await killChildren(() => false);
  expect(result).toMatchObject({ status: "ok", killed: 0, labels: [] });
  expect(result).not.toHaveProperty("continuationRetired");
  expect(child()).toEqual(before);
});

it("does not terminalize a parent whose pending final delivery owns its continuation", async () => {
  const before = parent()!;
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

it.each(["replacement revision", "unknown outcome"] as const)(
  "preserves parent write custody for %s",
  async (mode) => {
    const expected =
      mode === "replacement revision"
        ? { ...parent()!, lifecycleRevision: "replacement-revision" }
        : parent();
    const persist = lifecycleState.persistGatewaySessionLifecycleEvent;
    const unknown = new SqliteWorkerError(
      "controlled parent write outcome unknown",
      "outcome-unknown",
    );
    // Controlled writer outcome; this does not claim a real lost SQLite reply.
    using gate = vi
      .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
      .mockImplementation(async (params) => {
        if (params.sessionKey === parentKey && params.expectedWriter) {
          if (mode === "unknown outcome") {
            throw unknown;
          }
          replaceSessionEntrySync(target, expected!);
        }
        await persist(params);
      });
    if (mode === "unknown outcome") {
      const result = await stopParent().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(hasSqliteWorkerOutcomeUnknown(result)).toBe(true);
      expect(gate).toHaveBeenCalledOnce();
      expect(child()?.requesterSettleWake).toBeUndefined();
    } else {
      expect((await stopParent())?.[0]).toBe(true);
    }
    expect(parent()).toEqual(expected);
    expect(child()?.execution.outcome?.status).toBe("ok");
  },
);

it("full-session Stop retires a wake rearmed during retirement preparation", async () => {
  const oldGeneration = subagentRuns.get(childRunId)!.requesterSettleWake!.rearmGeneration ?? 0;
  const retire = registry.retireSubagentObligations;
  using gate = vi
    .spyOn(registry, "retireSubagentObligations")
    .mockImplementationOnce(async (entry, assertCurrent, options) => {
      // Parent pending-input selection already ran; the same completed child's
      // retirement mutation has not yet selected its current wake.
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
      expect(subagentRuns.get(childRunId)?.requesterSettleWake?.rearmGeneration).toBe(
        oldGeneration + 1,
      );
      await retire(entry, assertCurrent, options);
    });
  await expectStop();
  expect(gate).toHaveBeenCalledOnce();
  await expectRetiredParent();
});
