// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { writeFile } from "node:fs/promises";
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
  markRequesterTurnYielded,
  markSubagentRunTerminated,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { clearSessionQueues, enqueueFollowupRun } from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isPathInside } from "../../infra/path-guards.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { createChatAbortContext } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import type { RespondFn } from "./types.js";

const fixture = useChatAbortRegistryFixture();
const parentKey = "agent:main:dashboard:yielded-parent";
const parentId = "yielded-parent-session";
const parentRunId = "yielded-parent-run";
const childKey = "agent:main:subagent:yielded-child";
const childId = "yielded-child-session";
const childRunId = "yielded-child-run";

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
      event: { runId: parentRunId, sessionId: parentId, ts: Date.now(), data },
    });
  }
  registerSubagentRun({
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
    markRequesterTurnYielded({
      requesterSessionKey: parentKey,
      requesterAgentId: "main",
      requesterTurnRunId: parentRunId,
    }),
  ).toBe(1);
  expect(
    settleRequesterAfterSessionSpawns({
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
    status: "running",
    lifecycleRunId: parentRunId,
    endedAt: startedAt + 50,
    abortedLastRun: false,
  });
  expect(getSubagentRunByChildSessionKey(childKey)?.requesterSettleWake).toMatchObject({
    requesterYieldBatch: true,
  });
}

it.each(["unchanged", "new turn", "reset incarnation", "partial cancellation"] as const)(
  "session Stop preserves the %s parent at its acknowledgment boundary",
  async (race) => {
    await seedYieldedParent();
    if (race === "partial cancellation") {
      const brokenKey = "agent:broken:subagent:uncancellable";
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "broken",
        sessionKey: brokenKey,
        defaultSessionId: "broken-child-session",
      });
      registerSubagentRun({
        runId: "broken-child-run",
        childSessionKey: brokenKey,
        requesterSessionKey: parentKey,
        requesterAgentId: "main",
        requesterDisplayKey: parentKey,
        task: "Unreachable sibling",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const database = listOpenClawAgentDatabasesForTest().find(
        (item) => item.agentId === "broken" && isPathInside(fixture.stateDir, item.path),
      );
      if (!database) {
        throw new Error("Missing sibling database");
      }
      expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
      await writeFile(database.path, "not a SQLite database");
    }
    const context = createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    expect(context.chatAbortControllers.size).toBe(0);
    expect(resolveActiveEmbeddedRunOwner(parentId)).toBeUndefined();
    const captured = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
    if (!captured) {
      throw new Error("Missing seeded parent");
    }
    const replacement = {
      ...captured,
      ...(race === "new turn"
        ? {
            lifecycleRunId: "new-parent-run",
            activeWriterRunId: "new-parent-run",
            endedAt: undefined,
            startedAt: Date.now(),
          }
        : { lifecycleRevision: "new-incarnation" }),
    };
    let replacementPersistence: Promise<void> | undefined;
    const childAbort = vi.fn(() => {
      // The child signal follows the parent snapshot; replace it before Stop can persist.
      if (race === "new turn") {
        replacementPersistence = persistGatewaySessionLifecycleEvent({
          agentId: "main",
          sessionKey: parentKey,
          event: {
            runId: "new-parent-run",
            sessionId: parentId,
            ts: Date.now(),
            data: { phase: "start", startedAt: Date.now() },
          },
        });
      } else if (race === "reset incarnation") {
        replaceSessionEntrySync({ agentId: "main", sessionKey: parentKey }, replacement);
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
      acknowledgment.entry = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
    });
    try {
      await sessionAbortHandlers["sessions.abort"]!({
        req: { type: "req", id: "stop", method: "sessions.abort" },
        params: { key: parentKey, clearQueued: true },
        respond,
        context: context as never,
        client: {
          connId: "operator",
          connect: { scopes: ["operator.read", "operator.write"] },
        } as never,
        isWebchatConnect: () => false,
      });
      if (race === "partial cancellation") {
        expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("descendant cancellation was incomplete"),
          }),
        ]);
      } else {
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          { ok: true, abortedRunId: null, status: "aborted" },
        ]);
      }
      expect(childAbort).toHaveBeenCalledOnce();
      if (race === "new turn") {
        await replacementPersistence;
        expect(acknowledgment.entry).toMatchObject({
          status: "running",
          lifecycleRunId: "new-parent-run",
          abortedLastRun: false,
        });
        expect(acknowledgment.entry?.lastRunId).toBeUndefined();
        return;
      }
      if (race === "reset incarnation") {
        expect(acknowledgment.entry).toEqual(replacement);
        return;
      }
      expect(acknowledgment.entry).toMatchObject({
        status: "killed",
        abortedLastRun: true,
        lastRunId: parentRunId,
      });
      await fixture.settle();
      expect(getSubagentRunByChildSessionKey(childKey)?.killReconciliation).toMatchObject({
        suppressTaskDelivery: true,
      });
      expect(
        await markStartupOrphanedMainSessionsForRecovery({
          cfg: getRuntimeConfig(),
          stateDir: fixture.stateDir,
        }),
      ).toMatchObject({ marked: 0 });
      expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toMatchObject({
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
    agentId: "main",
    sessionKey: parentKey,
    defaultSessionId: parentId,
  });
  const before = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
  const respond = vi.fn();
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  await sessionAbortHandlers["sessions.abort"]!({
    req: { type: "req", id: "stop", method: "sessions.abort" },
    params: { key: parentKey, clearQueued: true },
    respond,
    context: context as never,
    client: {
      connId: "operator",
      connect: { scopes: ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: () => false,
  });
  expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
    true,
    { ok: true, abortedRunId: null, status: "no-active-run" },
  ]);
  expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toEqual(before);
});

it("does not cancel a yielded parent when Stop only clears a queued follow-up", async () => {
  await seedYieldedParent();
  expect(markSubagentRunTerminated({ runId: childRunId, reason: "killed" })).toBe(1);
  const before = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
  const followup = createQueueTestRun({ prompt: "Queued follow-up" });
  followup.run = { ...followup.run, agentId: "main", sessionId: parentId, sessionKey: parentKey };
  expect(
    enqueueFollowupRun(parentKey, followup, { mode: "followup" }, "none", undefined, false),
  ).toBe(true);
  const respond = vi.fn();
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  try {
    await sessionAbortHandlers["sessions.abort"]!({
      req: { type: "req", id: "stop", method: "sessions.abort" },
      params: { key: parentKey, clearQueued: true },
      respond,
      context: context as never,
      client: {
        connId: "operator",
        connect: { scopes: ["operator.read", "operator.write"] },
      } as never,
      isWebchatConnect: () => false,
    });
    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
      true,
      { ok: true, abortedRunId: null, status: "aborted" },
    ]);
    expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toEqual(before);
  } finally {
    clearSessionQueues([parentKey, parentId]);
  }
});
