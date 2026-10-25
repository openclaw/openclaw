// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { writeFile } from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { resolveActiveEmbeddedRunOwner } from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import {
  retireSubagentObligations,
  markSubagentRunTerminated,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadExactSessionEntryReadOnly,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isPathInside } from "../../infra/path-guards.js";
import { listRpcSourceEntries } from "../../sessions/session-controller.rpc-sources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import {
  abortContext,
  expectAbortFailure,
  expectCancelledSession,
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

it.each(["unchanged", "partial cancellation"] as const)(
  "session Stop preserves the %s parent at its acknowledgment boundary",
  async (race) => {
    await seedYieldedParent();
    if (race === "partial cancellation") {
      const brokenKey = "agent:broken:subagent:uncancellable";
      const brokenStore = await fixture.seedRun({
        runId: "broken-child-run",
        childSessionKey: brokenKey,
        childAgentId: "broken",
        sessionId: "broken-child-session",
        lifecycleRevision: "broken-child-revision",
        requesterSessionKey: parentKey,
        requesterTurnRunId: undefined,
        task: "Unreachable sibling",
        collect: undefined,
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
    expect(listRpcSourceEntries()).toHaveLength(0);
    expect(resolveActiveEmbeddedRunOwner(parentId)).toBeUndefined();
    const childAbort = vi.fn(() => {
      emitAgentEvent({
        runId: childRunId,
        sessionKey: childKey,
        sessionId: childId,
        stream: "lifecycle",
        data: { phase: "end", ...resolveAgentRunAbortLifecycleFields(AbortSignal.abort()) },
      });
      clearActiveEmbeddedRun(childId, child, childKey);
    });
    const child = createEmbeddedRunHandle({ runId: childRunId, abort: childAbort });
    setActiveEmbeddedRun(childId, child, childKey);
    let ack: ReturnType<typeof loadSessionEntry>;
    const respond = vi.fn<RespondFn>(() => {
      ack = loadSessionEntry(target);
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
      expectCancelledSession(ack, parentRunId);
      await fixture.settle();
      expect(await getSubagentRunByChildSessionKey(childKey)).toBeNull();
      expect(await markStartupRecovery()).toMatchObject({ marked: 0 });
      expectCancelledSession(loadSessionEntry(target), parentRunId);
    } finally {
      clearActiveEmbeddedRun(childId, child, childKey);
    }
  },
);

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
    let followup: ReturnType<typeof createQueueTestRun> | undefined;
    try {
      if (!pendingWake) {
        // Isolate queue clearing from a still-pending child continuation.
        await retireSubagentObligations(completedChild, () => {}, { requesterNotified: true });
        expect(
          (await getSubagentRunByChildSessionKey(childKey))?.requesterSettleWake,
        ).toBeUndefined();
      }
      const before = loadSessionEntry(target);
      followup = createQueueTestRun({ prompt: "Queued follow-up" });
      followup.run = {
        ...followup.run,
        agentId: "main",
        sessionId: parentId,
        sessionKey: parentKey,
      };
      expect(
        enqueueFollowupRun(parentKey, followup, { mode: "followup" }, "none", undefined, false),
      ).toBe(true);
      expect(getFollowupQueueDepth(parentKey)).toBe(1);
      const respond = vi.fn();
      await stopSession(parentKey, respond, abortContext(), { clearQueued: true });
      expectStopResult(respond);
      expect(getFollowupQueueDepth(parentKey)).toBe(0);
      await fixture.settle();
      if (pendingWake) {
        expectCancelledSession(loadSessionEntry(target), parentRunId);
        expect(await markStartupRecovery()).toMatchObject({ marked: 0 });
      } else {
        expect(loadSessionEntry(target)).toEqual(before);
      }
      expect(await getSubagentRunByChildSessionKey(childKey)).toBeNull();
    } finally {
      clearSessionQueues([parentKey, parentId], followup?.controllerInput?.target);
      if (followup?.controllerInput) {
        await followup.controllerInput.settlement.promise;
      }
      expect(getFollowupQueueDepth(parentKey)).toBe(0);
      expect(getFollowupQueueDepth(parentId)).toBe(0);
    }
  },
);
