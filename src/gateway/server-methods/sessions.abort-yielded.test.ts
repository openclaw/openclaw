// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { writeFile } from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  resolveActiveEmbeddedRunOwner,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import {
  cancelSubagentRequesterSettleWake,
  markSubagentRunTerminated,
  registerSubagentRun,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { clearFollowupDrainCallback } from "../../auto-reply/reply/queue/drain.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadExactSessionEntryReadOnly,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isPathInside } from "../../infra/path-guards.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import {
  abortContext,
  expectAbortFailure,
  expectStopResult,
  registerYieldedChild,
  seedYieldedSession,
  stopSession,
} from "./sessions.abort-lifecycle.test-support.js";
import type { RespondFn } from "./types.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:dashboard:yielded-parent";
const parentId = "yielded-parent-session";
const parentRunId = "yielded-parent-run";
const childKey = "agent:main:subagent:yielded-child";
const childId = "yielded-child-session";
const childRunId = "yielded-child-run";
const target = { agentId: "main", sessionKey: parentKey };
const markStartupRecovery = () =>
  markStartupOrphanedMainSessionsForRecovery({
    cfg: getRuntimeConfig(),
    stateDir: fixture.stateDir,
  });

async function seedYieldedParent() {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey,
    defaultSessionId: childId,
    lifecycleRevision: "original-incarnation",
  });
  const startedAt = await seedYieldedSession(fixture.stateDir, parentKey, parentId, parentRunId);
  await registerYieldedChild({
    parentKey,
    parentRunId,
    childKey,
    childRunId,
    startedAt,
    sessionEntry: loadSessionEntry({ agentId: "main", sessionKey: childKey }),
  });
}

it.each(["unchanged", "new turn", "reset incarnation", "partial cancellation"] as const)(
  "session Stop preserves the %s parent at its acknowledgment boundary",
  async (race) => {
    await seedYieldedParent();
    if (race === "partial cancellation") {
      const brokenKey = "agent:broken:subagent:uncancellable";
      const brokenStore = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "broken",
        sessionKey: brokenKey,
        defaultSessionId: "broken-child-session",
        lifecycleRevision: "broken-child-revision",
      });
      await registerSubagentRun({
        runId: "broken-child-run",
        childSessionKey: brokenKey,
        childAgentId: "broken",
        sessionEntry: loadSessionEntry({ agentId: "broken", sessionKey: brokenKey }),
        requesterSessionKey: parentKey,
        requesterAgentId: "main",
        requesterDisplayKey: parentKey,
        task: "Unreachable sibling",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const database = expectDefined(
        listOpenClawAgentDatabasesForTest().find(
          (item) => item.agentId === "broken" && isPathInside(fixture.stateDir, item.path),
        ),
        "sibling database",
      );
      expect(await closeOpenClawAgentDatabaseByPathAsync(database.path, "broken")).toBe(true);
      await writeFile(database.path, "not a SQLite database");
      expect(() =>
        loadExactSessionEntryReadOnly({ storePath: brokenStore, sessionKey: brokenKey }),
      ).toThrow();
    }
    const context = abortContext();
    expect(context.chatAbortControllers.size).toBe(0);
    expect(resolveActiveEmbeddedRunOwner(parentId)).toBeUndefined();
    const captured = expectDefined(loadSessionEntry(target), "seeded parent");
    const replacement = { ...captured, lifecycleRevision: "new-incarnation" };
    let replacementPersistence: Promise<void> | undefined;
    const childAbort = vi.fn(() => {
      // The child signal follows the parent snapshot; replace it before Stop can persist.
      if (race === "new turn") {
        replacementPersistence = persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            runId: "new-parent-run",
            sessionId: parentId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            ts: Date.now(),
            data: { phase: "start", startedAt: Date.now() },
          },
        });
      } else if (race === "reset incarnation") {
        replaceSessionEntrySync(target, replacement);
      }
      emitAgentEvent({
        runId: childRunId,
        sessionKey: childKey,
        sessionId: childId,
        stream: "lifecycle",
        data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
      });
    });
    const child = createEmbeddedRunHandle({ runId: childRunId, abort: childAbort });
    setActiveEmbeddedRun(childId, child, childKey);
    const acknowledgment: { entry: ReturnType<typeof loadSessionEntry> } = { entry: undefined };
    const respond = vi.fn<RespondFn>(() => {
      acknowledgment.entry = loadSessionEntry(target);
    });
    try {
      await stopSession(parentKey, respond, context, { clearQueued: true });
      if (race === "partial cancellation") {
        expectAbortFailure(
          respond,
          expect.stringContaining("descendant cancellation was incomplete"),
        );
      } else {
        expectStopResult(respond);
      }
      expect(childAbort).toHaveBeenCalledOnce();
      if (race === "new turn") {
        await replacementPersistence;
        expect(acknowledgment.entry).toMatchObject({
          lifecycleRunId: "new-parent-run",
          abortedLastRun: false,
        });
        expect(acknowledgment.entry?.status).toBeUndefined();
        expect(acknowledgment.entry?.lastRunId).toBeUndefined();
        return;
      }
      if (race === "reset incarnation") {
        expect(acknowledgment.entry).toEqual(replacement);
        return;
      }
      expect(acknowledgment.entry, JSON.stringify(respond.mock.calls[0])).toMatchObject({
        status: "killed",
        abortedLastRun: true,
        lastRunId: parentRunId,
      });
      await fixture.settle();
      expect((await getSubagentRunByChildSessionKey(childKey))?.killReconciliation).toMatchObject({
        suppressTaskDelivery: true,
      });
      expect(await markStartupRecovery()).toMatchObject({ marked: 0 });
      expect(loadSessionEntry(target)).toMatchObject({
        status: "killed",
        abortedLastRun: true,
      });
    } finally {
      await replacementPersistence;
      clearActiveEmbeddedRun(childId, child, childKey);
    }
  },
);

it("leaves an ownerless session without yielded work unchanged", async () => {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    ...target,
    defaultSessionId: parentId,
  });
  const before = loadSessionEntry(target);
  const respond = vi.fn();
  await stopSession(parentKey, respond, abortContext(), { clearQueued: true });
  expectStopResult(respond, "no-active-run");
  expect(loadSessionEntry(target)).toEqual(before);
});

it.each([false, true])(
  "cancels a yielded parent only when queue clearing retires a child wake (pending=%s)",
  async (pendingWake) => {
    await seedYieldedParent();
    expect(await markSubagentRunTerminated({ runId: childRunId, reason: "killed" })).toBe(1);
    const completedChild = expectDefined(
      await getSubagentRunByChildSessionKey(childKey),
      "completed child",
    );
    expect(completedChild.requesterSettleWake).toBeDefined();
    const childOutcome = structuredClone(completedChild.execution.outcome);
    if (!pendingWake) {
      // Isolate queue clearing from a still-pending child continuation.
      await cancelSubagentRequesterSettleWake(completedChild, () => {});
      expect(
        (await getSubagentRunByChildSessionKey(childKey))?.requesterSettleWake,
      ).toBeUndefined();
    }
    const before = loadSessionEntry(target);
    const followup = createQueueTestRun({ prompt: "Queued follow-up" });
    followup.run = { ...followup.run, agentId: "main", sessionId: parentId, sessionKey: parentKey };
    expect(
      enqueueFollowupRun(parentKey, followup, { mode: "followup" }, "none", undefined, false),
    ).toBe(true);
    expect(getFollowupQueueDepth(parentKey)).toBe(1);
    const respond = vi.fn();
    try {
      await stopSession(parentKey, respond, abortContext(), { clearQueued: true });
      expectStopResult(respond);
      expect(getFollowupQueueDepth(parentKey)).toBe(0);
      if (pendingWake) {
        expect(loadSessionEntry(target)).toMatchObject({
          status: "killed",
          abortedLastRun: true,
          lastRunId: parentRunId,
        });
        await fixture.settle();
        expect(await markStartupRecovery()).toMatchObject({ marked: 0 });
      } else {
        expect(loadSessionEntry(target)).toEqual(before);
      }
      const retiredChild = await getSubagentRunByChildSessionKey(childKey);
      expect(retiredChild?.requesterSettleWake).toBeUndefined();
      expect(retiredChild?.execution.outcome).toEqual(childOutcome);
    } finally {
      for (const key of [parentKey, parentId]) {
        clearFollowupQueue(key);
        clearFollowupDrainCallback(key);
        expect(getFollowupQueueDepth(key)).toBe(0);
      }
    }
  },
);
