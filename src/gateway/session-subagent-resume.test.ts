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
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "../agents/subagents/registry/subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "../agents/subagents/registry/subagent-registry-run-pause.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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

async function updateRun(runId: string, update: (draft: SubagentRunRecord) => void) {
  await mutateSubagentRuns([runId], (rows) => {
    const draft = structuredClone(rows.get(runId)!);
    update(draft);
    return { value: undefined, postimages: new Map([[runId, draft]]) };
  });
  return subagentRuns.get(runId)!;
}

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
  const entry = await updateRun(previousRunId, (draft) => {
    expect(markSubagentRunPausedAfterYield({ entry: draft })).toBe(true);
  });
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
    state.entry = await updateRun(previousRunId, (draft) => {
      draft.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
        batchRunIds: [previousRunId],
      };
    });
    const adopt = await state.prepare();
    await expect(adopt()).resolves.toBe(previousRunId);
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
    const stored = loadSubagentRegistryFromSqlite();
    expect(stored.get(nextRunId)).toMatchObject({
      taskRunId: previousRunId,
      requesterSessionKey: parent,
      task: next.task,
    });
    expect(stored.has(previousRunId)).toBe(false);
    await expect(adopt()).rejects.toThrow(/paused/);
  },
);

it("rejects adoption when task-owned completion is disabled after binding", async () => {
  const state = await arrangePausedChild();
  const adopt = await state.prepare();
  state.entry = await updateRun(previousRunId, (draft) => {
    draft.expectsCompletionMessage = false;
  });
  await expect(adopt()).rejects.toThrow("Task resume requires a child with task-owned completion.");
  expect(subagentRuns.has(nextRunId)).toBe(false);
  expect(subagentRuns.get(previousRunId)).toBe(state.entry);
  expect(state.entry.pauseReason).toBe("sessions_yield");
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
    if (stage === "selection") {
      expect(shouldResumeParentSubagent(state)).toBe(false);
      expect(() => bindParentSubagentResume({ ...state, childSessionId: sessionId })).toThrow(
        /controlled/,
      );
    } else {
      await expect(adopt()).rejects.toThrow(/controlled/);
    }
    expect(subagentRuns.has(nextRunId)).toBe(false);
    expect(subagentRuns.get(previousRunId)?.pauseReason).toBe("sessions_yield");
  },
);

it.each(["resume", "cancel"] as const)(
  "preserves %s for retained release-era tasks without store provenance",
  async (action) => {
    const state = await arrangePausedChild();
    const storePath = state.entry.controllerStorePath!;
    // v2026.9.5 registration persisted neither physical-store field.
    await updateRun(previousRunId, (draft) => {
      delete draft.controllerStorePath;
      delete draft.requesterStorePath;
    });
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    state.entry = subagentRuns.get(previousRunId)!;
    publishSystemEventStoreResolver(() => storePath);
    await fixture.settle();
    expect(shouldResumeParentSubagent(state)).toBe(false);
    if (action === "resume") {
      const resume = bindParentSubagentResume({ ...state, childSessionId: sessionId });
      const adopt = await state.prepare({ resume });
      await expect(adopt()).resolves.toBe(previousRunId);
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
      expect(subagentRuns.get(previousRunId)?.endedReason).toBe("subagent-killed");
    }
  },
);

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
    if (race === "cancel" || race === "complete" || race === "replace") {
      state.entry = await updateRun(previousRunId, (draft) => {
        if (race === "cancel") {
          draft.killIntent = { requestedAt: Date.now(), reason: "killed" };
        } else if (race === "complete") {
          draft.pauseReason = undefined;
        } else {
          draft.generation = (draft.generation ?? 0) + 1;
        }
      });
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
    await expect(adopt()).rejects.toThrow();
    expect(subagentRuns.has(nextRunId)).toBe(false);
    expect(subagentRuns.get(previousRunId)).toBe(state.entry);
  },
);

it("checks transcript incarnation even if the target key and task still match", async () => {
  const state = await arrangePausedChild();
  state.entry = await updateRun(previousRunId, (draft) => {
    draft.execution.transcriptTarget = { sessionId: "previous-incarnation" };
  });
  expect(() =>
    assertParentSubagentResumeCurrent({
      cfg: state.cfg,
      resume: state.resume,
      sessionKey: state.childSessionKey,
      sessionId,
    }),
  ).toThrow(/changed/);
});

it("rejects a foreign task replacement instead of accepting untracked work", async () => {
  const state = await arrangePausedChild();
  const adopt = await state.prepare();
  const replacement = {
    ...state.entry,
    generation: state.entry.generation! + 1,
    task: "replacement task",
  };
  // An independent writer changes execution ownership before the worker's version check.
  writeSubagentRunValuesInDatabase(
    openOpenClawStateDatabase(),
    [bindSubagentRunRecord(replacement)],
    [],
  );
  await expect(adopt()).rejects.toThrow(/changed/);
  expect(subagentRuns.has(nextRunId)).toBe(false);
  expect(subagentRuns.get(previousRunId)).toEqual(replacement);
  const stored = loadSubagentRegistryFromSqlite();
  expect(stored.has(nextRunId)).toBe(false);
  expect(stored.get(previousRunId)).toEqual(replacement);
});

it("delivers a result once after the former synchronous wait window, through the task owner", async () => {
  const state = await arrangePausedChild();
  const completion = createDeferred<AgentWaitResult>();
  const announce = fixture.announce.mockResolvedValue("delivered");
  fixture.gateway.mockReturnValue(completion.promise);
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  const adopt = await state.prepare();
  await adopt();
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
  expect(subagentRuns.get(nextRunId)?.cleanupCompletedAt).toBeDefined();
  expect(subagentRuns.get(nextRunId)?.pauseReason).toBeUndefined();
  expect(announce).toHaveBeenCalledTimes(1);
});

it("does not grant control to a separate completion recipient", async () => {
  const state = await arrangePausedChild();
  state.entry = await updateRun(previousRunId, (draft) => {
    draft.controllerSessionKey = "agent:main:dashboard:actual-controller";
    draft.controllerStorePath = "controller-store";
    draft.requesterStorePath = "completion-store";
  });
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
  const controller = { ...state.caller, sessionKey: "agent:main:dashboard:actual-controller" };
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
  await adopt();
  expect(() => assertParentSubagentResumeSuccessorCurrent(state.resume, nextRunId)).not.toThrow();
  await updateRun(nextRunId, (draft) => {
    draft.killIntent = { requestedAt: Date.now(), reason: "killed" };
  });
  expect(() => assertParentSubagentResumeSuccessorCurrent(state.resume, nextRunId)).toThrow(
    /no longer owns/,
  );
});
