/** Real registry and SQLite proof for explicit parent-owned resume admission. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../agents/subagents/registry/subagent-control.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AgentWaitResult } from "../agents/run-wait.js";
import { resolveSubagentController } from "../agents/subagents/registry/subagent-control-scope.js";
import { killAllControlledSubagentRuns } from "../agents/subagents/registry/subagent-control.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "../agents/subagents/registry/subagent-registry-run-pause.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { getRuntimeConfig } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import { findTaskByRunId } from "../tasks/task-registry.js";
import { resolveGatewayAgentTaskTrackingMode } from "./server-methods/agent-task-tracking.js";
import {
  assertParentSubagentResumeCurrent,
  assertParentSubagentResumeSuccessorCurrent,
  bindParentSubagentResume,
  prepareParentSubagentResume,
  shouldResumeParentSubagent,
} from "./session-subagent-resume.js";

const fixture = useSubagentControlFixture();
const parent = "agent:main:main";
const sessionId = "resume-child-session";
const previousRunId = "resume-previous";
const nextRunId = "resume-successor";
afterEach(() => {
  publishSystemEventStoreResolver(undefined);
  vi.useRealTimers();
});

// Seed the same paused registry state that the yield terminal observer records.
async function arrangePausedChild(childSessionKey = "agent:main:subagent:resume-child") {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: sessionId,
  });
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: parent,
    defaultSessionId: "resume-parent-session",
  });
  await registerSubagentRun({
    runId: previousRunId,
    childSessionKey,
    requesterSessionKey: parent,
    controllerSessionKey: parent,
    requesterDisplayKey: parent,
    task: "Wait for input",
    cleanup: "keep",
    expectsCompletionMessage: true,
    queued: true,
  });
  const entry = subagentRuns.get(previousRunId)!;
  expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
  const caller = { agentId: "main", sessionKey: parent, assertCurrent: vi.fn() };
  const cfg = getRuntimeConfig();
  const resume = bindParentSubagentResume({
    cfg,
    caller,
    childSessionKey,
    childSessionId: sessionId,
  });
  const prepare = (overrides: Partial<Parameters<typeof prepareParentSubagentResume>[0]> = {}) =>
    prepareParentSubagentResume({
      cfg,
      resume,
      sessionKey: childSessionKey,
      getSessionId: () => sessionId,
      runId: nextRunId,
      task: "Continue with the supplied answer",
      assertAdmissionCurrent: vi.fn(),
      ...overrides,
    });
  return { cfg, caller, entry, resume, prepare, childSessionKey };
}

it.each(["agent:main:subagent:resume-child", "agent:main:dashboard:resume-child"])(
  "preserves the task and frozen completion batch for %s",
  async (childSessionKey) => {
    const state = await arrangePausedChild(childSessionKey);
    state.entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
      batchRunIds: [previousRunId],
    };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
    const taskId = findTaskByRunId(previousRunId)?.taskId;
    expect(taskId).toBeTruthy();
    const adopt = await state.prepare();
    expect(adopt()).toBe(previousRunId);
    const next = subagentRuns.get(nextRunId)!;
    expect(next).toMatchObject({
      taskRunId: previousRunId,
      requesterSessionKey: parent,
      controllerSessionKey: parent,
      task: "Continue with the supplied answer",
    });
    expect(next.generation).toBeGreaterThan(state.entry.generation!);
    expect(next.pauseReason).toBeUndefined();
    expect(next.requesterSettleWake?.batchRunIds).toEqual([nextRunId]);
    expect(subagentRuns.has(previousRunId)).toBe(false);
    expect(findTaskByRunId(previousRunId)?.taskId).toBe(taskId);
    expect(findTaskByRunId(previousRunId)?.status).toBe("running");
    const stored = loadSubagentRegistryFromSqlite();
    expect(stored.get(nextRunId)).toMatchObject({
      taskRunId: previousRunId,
      requesterSessionKey: parent,
      task: next.task,
    });
    expect(stored.has(previousRunId)).toBe(false);
    expect(() => adopt()).toThrow(/paused/);
  },
);

it("rejects binding a paused child without task-owned completion", async () => {
  const state = await arrangePausedChild();
  const task = findTaskByRunId(previousRunId);
  expect(task).toBeDefined();
  state.entry.expectsCompletionMessage = false;
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
  expect(() =>
    bindParentSubagentResume({
      cfg: state.cfg,
      caller: state.caller,
      childSessionKey: state.childSessionKey,
      childSessionId: sessionId,
    }),
  ).toThrow("Task resume requires a child with task-owned completion.");
  expect(subagentRuns.has(nextRunId)).toBe(false);
  expect(subagentRuns.get(previousRunId)).toBe(state.entry);
  expect(state.entry.pauseReason).toBe("sessions_yield");
  expect(findTaskByRunId(previousRunId)).toEqual(task);
});

it("rejects adoption when task-owned completion is disabled after binding", async () => {
  const state = await arrangePausedChild();
  const task = findTaskByRunId(previousRunId);
  expect(task).toBeDefined();
  const adopt = await state.prepare();
  state.entry.expectsCompletionMessage = false;
  persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
  expect(() => adopt()).toThrow("Task resume requires a child with task-owned completion.");
  expect(subagentRuns.has(nextRunId)).toBe(false);
  expect(subagentRuns.get(previousRunId)).toBe(state.entry);
  expect(state.entry.pauseReason).toBe("sessions_yield");
  expect(findTaskByRunId(previousRunId)).toEqual(task);
});

it.each(["selection", "admission"] as const)(
  "rejects a copied-store parent with matching session identities during %s",
  async (stage) => {
    const state = await arrangePausedChild();
    const originalStorePath = state.entry.controllerStorePath;
    if (!originalStorePath) {
      throw new Error("The registered task must retain its controller store");
    }
    publishSystemEventStoreResolver(() => originalStorePath);
    expect(shouldResumeParentSubagent(state)).toBe(true);
    const adopt = await state.prepare();
    publishSystemEventStoreResolver(() => `${originalStorePath}.replacement`);
    const task = findTaskByRunId(previousRunId);
    if (stage === "selection") {
      expect(shouldResumeParentSubagent(state)).toBe(false);
      expect(() => bindParentSubagentResume({ ...state, childSessionId: sessionId })).toThrow(
        /controlled/,
      );
    } else {
      expect(() => adopt()).toThrow(/controlled/);
    }
    expect(subagentRuns.has(nextRunId)).toBe(false);
    expect(subagentRuns.get(previousRunId)?.pauseReason).toBe("sessions_yield");
    expect(findTaskByRunId(previousRunId)).toEqual(task);
  },
);

it.each(["resume", "cancel"] as const)(
  "preserves %s for retained release-era tasks without store provenance",
  async (action) => {
    const state = await arrangePausedChild();
    const storePath = state.entry.controllerStorePath!;
    // v2026.9.5 registration persisted neither physical-store field.
    delete state.entry.controllerStorePath;
    delete state.entry.requesterStorePath;
    persistSubagentRunsToDiskOrThrow(subagentRuns, [previousRunId]);
    subagentRuns.set(previousRunId, loadSubagentRegistryFromSqlite().get(previousRunId)!);
    publishSystemEventStoreResolver(() => storePath);
    expect(shouldResumeParentSubagent(state)).toBe(false);
    if (action === "resume") {
      const resume = bindParentSubagentResume({ ...state, childSessionId: sessionId });
      const adopt = await state.prepare({ resume });
      expect(adopt()).toBe(previousRunId);
      expect(subagentRuns.get(nextRunId)?.taskRunId).toBe(previousRunId);
    } else {
      const result = await killAllControlledSubagentRuns({
        cfg: state.cfg,
        controller: resolveSubagentController({
          cfg: state.cfg,
          agentId: state.caller.agentId,
          agentSessionKey: state.caller.sessionKey,
        }),
        runs: [subagentRuns.get(previousRunId)!],
        suppressTaskDelivery: true,
      });
      expect(result).toMatchObject({ killed: 1 });
      expect(findTaskByRunId(previousRunId)?.status).toBe("cancelled");
    }
  },
);

it("does not adopt ordinary peer messages or forged message provenance", async () => {
  const state = await arrangePausedChild();
  expect(
    resolveGatewayAgentTaskTrackingMode({
      client: null,
      sessionKey: state.childSessionKey,
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: parent,
      },
    }),
  ).toBe("none");
  expect(subagentRuns.get(previousRunId)).toBe(state.entry);
  expect(() =>
    bindParentSubagentResume({
      cfg: state.cfg,
      caller: { ...state.caller, sessionKey: "agent:main:dashboard:unrelated" },
      childSessionKey: state.childSessionKey,
      childSessionId: sessionId,
    }),
  ).toThrow(/controlled/);
});

it.each(["cancel", "complete", "replace", "session", "caller", "admission"] as const)(
  "rejects a %s race after preparing admission without creating a successor",
  async (race) => {
    const state = await arrangePausedChild();
    const assertAdmissionCurrent = vi.fn();
    let currentSessionId = sessionId;
    const adopt = await state.prepare({
      getSessionId: () => currentSessionId,
      assertAdmissionCurrent,
    });
    if (race === "cancel") {
      state.entry.killIntent = { requestedAt: Date.now(), reason: "killed" };
    }
    if (race === "complete") {
      state.entry.pauseReason = undefined;
    }
    if (race === "replace") {
      state.entry.generation = (state.entry.generation ?? 0) + 1;
    }
    if (race === "session") {
      currentSessionId = "replaced-session";
    }
    if (race === "caller") {
      state.caller.assertCurrent.mockImplementation(() => {
        throw new Error("caller retired");
      });
    }
    if (race === "admission") {
      assertAdmissionCurrent.mockImplementation(() => {
        throw new Error("admission retired");
      });
    }
    expect(() => adopt()).toThrow();
    expect(subagentRuns.has(nextRunId)).toBe(false);
    expect(subagentRuns.get(previousRunId)).toBe(state.entry);
  },
);

it("checks transcript incarnation even if the target key and task still match", async () => {
  const state = await arrangePausedChild();
  state.entry.execution.transcriptTarget = { sessionId: "previous-incarnation" };
  expect(() =>
    assertParentSubagentResumeCurrent({
      cfg: state.cfg,
      resume: state.resume,
      sessionKey: state.childSessionKey,
      sessionId,
    }),
  ).toThrow(/changed/);
});

it("rolls back a rejected durable replacement instead of accepting untracked work", async () => {
  const state = await arrangePausedChild();
  const adopt = await state.prepare();
  // Diverge the source from its durable snapshot to exercise the real atomic CAS rejection.
  state.entry.task = "uncommitted source change";
  expect(() => adopt()).toThrow(/source changed/);
  expect(subagentRuns.has(nextRunId)).toBe(false);
  expect(subagentRuns.get(previousRunId)?.pauseReason).toBe("sessions_yield");
  expect(loadSubagentRegistryFromSqlite().has(previousRunId)).toBe(true);
});

it("delivers a result once after the former synchronous wait window, through the task owner", async () => {
  const state = await arrangePausedChild();
  const completion = createDeferred<AgentWaitResult>();
  const announce = fixture.announce.mockResolvedValue("delivered");
  fixture.gateway.mockReturnValue(completion.promise);
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  const adopt = await state.prepare();
  adopt();
  vi.setSystemTime(now + 60_000);
  expect(announce).not.toHaveBeenCalled();
  completion.resolve({
    status: "ok",
    startedAt: now,
    endedAt: Date.now(),
    terminalReply: { disposition: "visible", text: "The resumed task is complete." },
  });
  await fixture.settle();
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledWith(
    expect.objectContaining({
      childRunId: nextRunId,
      requesterSessionKey: parent,
      roundOneReply: "The resumed task is complete.",
    }),
  );
  emitAgentEvent({
    runId: previousRunId,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now(), yielded: true },
  });
  await fixture.settle();
  expect(findTaskByRunId(previousRunId)?.status).toBe("succeeded");
  expect(subagentRuns.get(nextRunId)?.pauseReason).toBeUndefined();
  expect(announce).toHaveBeenCalledTimes(1);
});

it("does not grant control to a separate completion recipient", async () => {
  const state = await arrangePausedChild();
  state.entry.controllerSessionKey = "agent:main:dashboard:actual-controller";
  state.entry.controllerStorePath = "controller-store";
  state.entry.requesterStorePath = "completion-store";
  publishSystemEventStoreResolver((key) =>
    key === state.entry.controllerSessionKey ? "controller-store" : "completion-store",
  );
  expect(() =>
    bindParentSubagentResume({
      cfg: state.cfg,
      caller: state.caller,
      childSessionKey: state.childSessionKey,
      childSessionId: sessionId,
    }),
  ).toThrow(/controlled/);
  const controller = { ...state.caller, sessionKey: state.entry.controllerSessionKey };
  expect(
    bindParentSubagentResume({
      cfg: state.cfg,
      caller: controller,
      childSessionKey: state.childSessionKey,
      childSessionId: sessionId,
    }).taskRunId,
  ).toBe(previousRunId);
});

it("retires queued resume execution when the successor is cancelled", async () => {
  const state = await arrangePausedChild();
  const adopt = await state.prepare();
  adopt();
  expect(() => assertParentSubagentResumeSuccessorCurrent(state.resume, nextRunId)).not.toThrow();
  subagentRuns.get(nextRunId)!.killIntent = { requestedAt: Date.now(), reason: "killed" };
  expect(() => assertParentSubagentResumeSuccessorCurrent(state.resume, nextRunId)).toThrow(
    /no longer owns/,
  );
});

async function assertCallbackResume(childSessionKey: string) {
  const state = await arrangePausedChild(childSessionKey);
  const { completeHostPluginAsyncCallback } =
    await import("../agents/plugin-async-callback.host.js");
  const { runPluginAsyncCallbackCommand } = await import("../agents/plugin-async-callback.js");
  const { captureOpenClawStateWorkerContext } =
    await import("../state/openclaw-state-worker-context.js");
  const { loadPendingSessionDelivery } = await import("../infra/session-delivery-queue-storage.js");
  const { deliverNativeChildCallback } = await import("./session-plugin-callback-delivery.js");
  const recovery = await import("./server-recovery-runtime-context.js");
  const queueContext = captureOpenClawStateWorkerContext();
  const binding = {
    pluginId: "example",
    toolName: "remote_job",
    childSessionKey: state.childSessionKey,
    childSessionId: sessionId,
    childRunId: previousRunId,
    childGeneration: state.entry.generation,
    childCreatedAt: state.entry.createdAt,
  };
  const issued = await runPluginAsyncCallbackCommand(
    {
      type: "pluginCallback.issue",
      input: { binding, ttlMs: 60000 },
    },
    () => {},
    queueContext,
  );
  // The initiating handle is not retained: a newly loaded plugin redeems only
  // its private token through the public completion implementation.
  expect(
    await completeHostPluginAsyncCallback({
      pluginId: "other",
      token: issued.token,
      resultText: "wrong owner",
      assertPluginCurrent: () => {},
    }),
  ).toBe("unknown");
  expect(
    await completeHostPluginAsyncCallback({
      pluginId: "example",
      token: issued.token,
      resultText: "remote result",
      assertPluginCurrent: () => {},
    }),
  ).toBe("accepted");
  const { loadPendingSessionDeliveries } =
    await import("../infra/session-delivery-queue-storage.js");
  const entries = await loadPendingSessionDeliveries(queueContext);
  const queued = entries.find(
    (entry) => entry.kind === "nativeChildFollowup" && !entry.callbackExpiryKey,
  )!;
  expect(queued.kind).toBe("nativeChildFollowup");
  if (queued.kind !== "nativeChildFollowup") {
    throw new Error("missing callback outbox");
  }
  expect(queued.message).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  const completion = createDeferred<AgentWaitResult>();
  fixture.gateway.mockReturnValue(completion.promise);
  fixture.announce.mockResolvedValue("delivered");
  const dispatch = vi
    .spyOn(recovery, "dispatchGatewayLifecycleMethod")
    .mockImplementation(async (_method, request, options) => {
      const resume = options?.subagentResume;
      if (!resume) {
        throw new Error("missing trusted callback admission");
      }
      expect(resume.caller).toBeUndefined();
      const adopt = await prepareParentSubagentResume({
        cfg: state.cfg,
        resume,
        sessionKey: state.childSessionKey,
        getSessionId: () => sessionId,
        runId: String(request.idempotencyKey),
        task: String(request.message),
        assertAdmissionCurrent: () => {},
      });
      return { status: "accepted", taskRunId: adopt() };
    });
  await deliverNativeChildCallback({ entry: queued, queueContext });
  const resumedRun = `plugin-callback:${queued.id}`;
  expect(loadSubagentRegistryFromSqlite().get(resumedRun)).toMatchObject({
    requesterSessionKey: parent,
    taskRunId: previousRunId,
  });
  // Simulate recovery of the same still-pending durable outbox after acceptance.
  expect(await loadPendingSessionDelivery(queued.id, queueContext)).not.toBeNull();
  await deliverNativeChildCallback({ entry: queued, queueContext });
  expect(dispatch).toHaveBeenCalledTimes(1);
  const { drainPendingSessionDelivery } =
    await import("../infra/session-delivery-queue-recovery.js");
  expect(
    await drainPendingSessionDelivery({
      id: queued.id,
      queueContext,
      logLabel: "callback recovery",
      log: { info() {}, warn() {}, error() {} },
      deliver: async (entry, context) => {
        if (entry.kind !== "nativeChildFollowup") {
          throw new Error("wrong queue kind");
        }
        await deliverNativeChildCallback({ entry, ...context });
      },
    }),
  ).toBeNull();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(
    await completeHostPluginAsyncCallback({
      pluginId: "example",
      token: issued.token,
      resultText: "duplicate",
      assertPluginCurrent: () => {},
    }),
  ).toBe("duplicate");
  completion.resolve({
    status: "ok",
    startedAt: Date.now(),
    endedAt: Date.now(),
    terminalReply: { disposition: "visible", text: "Verified remote result" },
  });
  await fixture.settle();
  expect(fixture.announce).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      childRunId: resumedRun,
      requesterSessionKey: parent,
      roundOneReply: "Verified remote result",
    }),
  );
}

it.each(["agent:main:subagent:callback-child", "agent:main:dashboard:visible-child"])(
  "resumes a durable plugin callback through the original task and requester exactly once for %s",
  assertCallbackResume,
);

it("dead-letters a callback timeout when its child never yields", async () => {
  const state = await arrangePausedChild();
  const { openOpenClawStateDatabase, runOpenClawStateWriteTransaction } =
    await import("../state/openclaw-state-db.js");
  const { issuePluginAsyncCallbackInDatabase } =
    await import("../agents/plugin-async-callback.store.js");
  const { captureOpenClawStateWorkerContext } =
    await import("../state/openclaw-state-worker-context.js");
  const { drainPendingSessionDelivery } =
    await import("../infra/session-delivery-queue-recovery.js");
  const { deliverNativeChildCallback } = await import("./session-plugin-callback-delivery.js");
  const database = openOpenClawStateDatabase();
  const issued = runOpenClawStateWriteTransaction(
    () =>
      issuePluginAsyncCallbackInDatabase(
        database,
        {
          pluginId: "example",
          toolName: "remote_job",
          childSessionKey: state.childSessionKey,
          childSessionId: sessionId,
          childRunId: previousRunId,
          childGeneration: state.entry.generation,
          childCreatedAt: state.entry.createdAt,
        },
        100,
        Date.now() - 2 * 60 * 60_000,
      ),
    { database },
  );
  state.entry.pauseReason = undefined;
  state.entry.execution.status = "running";
  const queueContext = captureOpenClawStateWorkerContext();
  const { loadPendingSessionDelivery } = await import("../infra/session-delivery-queue-storage.js");
  const entry = (await loadPendingSessionDelivery(issued.queueId, queueContext))!;
  expect(entry.kind).toBe("nativeChildFollowup");
  if (entry.kind !== "nativeChildFollowup") {
    throw new Error("missing callback expiry");
  }
  // Before the grace deadline, a running child is still eligible to yield.
  await expect(
    deliverNativeChildCallback({
      entry: { ...entry, yieldDeadline: Date.now() + 60_000 },
      queueContext,
    }),
  ).rejects.toThrow("waiting for its originating child to yield");
  // A committed result has the same bound: it cannot wait forever either.
  await expect(
    deliverNativeChildCallback({
      entry: { ...entry, callbackExpiryKey: undefined, message: "completed result" },
      queueContext,
    }),
  ).rejects.toThrow("did not yield before its delivery deadline");
  const dispatch = vi.spyOn(
    await import("./server-recovery-runtime-context.js"),
    "dispatchGatewayLifecycleMethod",
  );
  expect(
    await drainPendingSessionDelivery({
      id: issued.queueId,
      queueContext,
      logLabel: "callback deadline",
      log: { info() {}, warn() {}, error() {} },
      deliver: async (queued, context) => {
        if (queued.kind !== "nativeChildFollowup") {
          throw new Error("wrong queue kind");
        }
        await deliverNativeChildCallback({ entry: queued, ...context });
      },
    }),
  ).toBeNull();
  expect(dispatch).not.toHaveBeenCalled();
  expect(await loadPendingSessionDelivery(issued.queueId, queueContext)).toBeNull();
  expect(
    database.db
      .prepare("SELECT status FROM delivery_queue_entries WHERE id = ?")
      .get(issued.queueId),
  ).toEqual({ status: "failed" });
});

it("delivers an overdue callback timeout through the real queue instead of losing it at its deadline", async () => {
  const state = await arrangePausedChild();
  const { openOpenClawStateDatabase, runOpenClawStateWriteTransaction } =
    await import("../state/openclaw-state-db.js");
  const { issuePluginAsyncCallbackInDatabase } =
    await import("../agents/plugin-async-callback.store.js");
  const { captureOpenClawStateWorkerContext } =
    await import("../state/openclaw-state-worker-context.js");
  const { drainPendingSessionDelivery } =
    await import("../infra/session-delivery-queue-recovery.js");
  const { deliverNativeChildCallback } = await import("./session-plugin-callback-delivery.js");
  const recovery = await import("./server-recovery-runtime-context.js");
  const database = openOpenClawStateDatabase();
  // Seed the same durable rows as a process that stopped before its deadline.
  const issued = runOpenClawStateWriteTransaction(
    () =>
      issuePluginAsyncCallbackInDatabase(
        database,
        {
          pluginId: "example",
          toolName: "remote_job",
          childSessionKey: state.childSessionKey,
          childSessionId: sessionId,
          childRunId: previousRunId,
          childGeneration: state.entry.generation,
          childCreatedAt: state.entry.createdAt,
        },
        100,
        Date.now() - 1000,
      ),
    { database },
  );
  const dispatch = vi
    .spyOn(recovery, "dispatchGatewayLifecycleMethod")
    .mockImplementation(async (_method, request, options) => {
      expect(request.message).toContain("expired without a result");
      expect(options?.subagentResume?.previousRunId).toBe(previousRunId);
      return { status: "accepted", taskRunId: previousRunId };
    });
  expect(
    await drainPendingSessionDelivery({
      id: issued.queueId,
      queueContext: captureOpenClawStateWorkerContext(),
      logLabel: "expiry recovery",
      log: { info() {}, warn() {}, error() {} },
      deliver: async (entry, context) => {
        if (entry.kind !== "nativeChildFollowup") {
          throw new Error("wrong queue kind");
        }
        await deliverNativeChildCallback({ entry, ...context });
      },
    }),
  ).toBeNull();
  expect(dispatch).toHaveBeenCalledOnce();
});
