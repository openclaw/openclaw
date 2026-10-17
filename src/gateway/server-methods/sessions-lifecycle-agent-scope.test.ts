import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  createArchivedSubagentSweeperRun,
  createSubagentSweeperHarness,
} from "../../agents/subagents/registry/subagent-registry-sweeper.test-support.js";
import { deleteSubagentSessionForCleanup } from "../../agents/subagents/registry/subagent-session-cleanup.js";
import {
  clearFollowupQueueForTest,
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { hasSessionLifecycleQueueWork } from "../../auto-reply/reply/queue/cleanup.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { FOLLOWUP_QUEUES } from "../../auto-reply/reply/queue/state.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { clearCommandLane, enqueueCommandInLane } from "../../process/command-queue.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { RespondFn } from "./types.js";

useChatAbortRegistryFixture();

function lifecycleConfig() {
  const current = getRuntimeConfig();
  const cfg = { ...current, agents: { ...current.agents, entries: { main: {}, research: {} } } };
  setRuntimeConfigSnapshot(cfg);
}

function gateway(extraHandlers = { ...sessionDeleteHandlers, ...sessionMutationHandlers }) {
  const cfg = getRuntimeConfig();
  const client = sharingPolicyClient({
    user: ensureProfileForEmail("operator@example.test").id,
    scopes: ["operator.admin"],
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  return async (method: string, params: unknown) => {
    const replies: Parameters<RespondFn>[] = [];
    await handleGatewayRequest({
      req: { type: "req", id: "lifecycle-scope", method, params },
      client,
      context,
      respond: (...reply) => replies.push(reply),
      isWebchatConnect: () => false,
      extraHandlers,
    });
    expect(replies).toHaveLength(1);
    const [ok, body, error] = replies[0]!;
    expect({ ok, error }, JSON.stringify(replies[0])).toEqual({ ok: true, error: undefined });
    return body;
  };
}

it.each(["sweep", "cleanup"] as const)(
  "%s removes the recorded raw child owner without deleting another agent's global session",
  async (flow) => {
    lifecycleConfig();
    for (const agentId of ["main", "research"]) {
      await upsertSessionEntryCore(
        { agentId, sessionKey: "global" },
        {
          sessionId: `${agentId}-global`,
          lifecycleRevision: `${agentId}-revision`,
          updatedAt: Date.now(),
        },
      );
    }
    const mainBefore = loadSessionEntry({ agentId: "main", sessionKey: "global" });
    const call = gateway(sessionDeleteHandlers);
    const entry = createArchivedSubagentSweeperRun({
      childSessionKey: "global",
      childAgentId: "research",
      childSessionIdentity: {
        sessionId: "research-global",
        lifecycleRevision: "research-revision",
      },
    });
    const h = createSubagentSweeperHarness({}, entry);
    h.callGateway.mockImplementation(async (request) => {
      await request.prepareDispatchCurrent?.();
      request.assertDispatchCurrent?.();
      return call(request.method, request.params);
    });
    try {
      if (flow === "sweep") {
        await h.sweeper.sweepOnce();
        expect(h.runs.has(entry.runId)).toBe(false);
      } else {
        expect(
          await deleteSubagentSessionForCleanup({
            callGateway: h.callGateway,
            childSessionKey: entry.childSessionKey,
            childAgentId: entry.childAgentId,
            expectedSessionId: "research-global",
            expectedLifecycleRevision: "research-revision",
          }),
        ).toBe("deleted");
      }
      expect(loadSessionEntry({ agentId: "research", sessionKey: "global" })).toBeUndefined();
      expect(loadSessionEntry({ agentId: "main", sessionKey: "global" })).toEqual(mainBefore);
    } finally {
      await h.sweeper.reset();
    }
  },
);

it.each([
  { method: "sessions.delete", key: "global", agentId: "research" },
  { method: "sessions.reset", key: "global", agentId: "research" },
  { method: "sessions.delete", key: "shared", agentId: "research" },
  { method: "sessions.reset", key: "shared", agentId: "research" },
  { method: "sessions.patch", key: "shared", agentId: "research" },
  { method: "sessions.reset", key: "global", agentId: "main" },
  { method: "sessions.delete", key: "shared", agentId: "main" },
])("$method preserves another agent's $key work ($agentId)", async ({ method, key, agentId }) => {
  lifecycleConfig();
  const foreignAgentId = agentId === "main" ? "research" : "main";
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: getRuntimeConfig(),
    key,
    agentId,
    projection: "list",
    exactRead: true,
    readOnly: false,
  });
  const targetId = `${agentId}-session`;
  await upsertSessionEntryCore(
    { agentId, sessionKey: target.canonicalKey },
    { sessionId: targetId, lifecycleRevision: "original", updatedAt: 1 },
  );
  const foreignTarget = {
    agentId: foreignAgentId,
    sessionKey: key,
    sessionId: `${foreignAgentId}-session`,
  };
  const ownedTarget = { agentId, sessionKey: target.canonicalKey, sessionId: targetId };
  const operation = createReplyOperation({ ...foreignTarget, resetTriggered: false });
  operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
  const followup = (sessionTarget: typeof foreignTarget) => {
    const run = createQueueTestRun({ prompt: sessionTarget.agentId });
    Object.assign(run.run, sessionTarget);
    const settled = vi.fn();
    run.turnAdoptionLifecycle = {
      admission: "cancel-only",
      onAdopted: () => {},
      onSettled: settled,
    };
    enqueueFollowupRun(key, run, createQueueSettings(), "none", undefined, false);
    return { run, settled };
  };
  const foreign = followup(foreignTarget);
  const hasOwnedWork = () => hasSessionLifecycleQueueWork({ keys: [key], ...ownedTarget });
  const entered = createDeferred();
  const release = createDeferred();
  const lane = resolveEmbeddedSessionLane(key);
  const blocker = enqueueCommandInLane(lane, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const foreignTask = vi.fn(async () => "preserved");
  const ownedTask = vi.fn(async () => "must not run");
  const queuedResult = Promise.allSettled([
    enqueueCommandInLane(lane, foreignTask, { sessionTarget: foreignTarget }),
    enqueueCommandInLane(lane, ownedTask, { sessionTarget: { ...ownedTarget, sessionKey: key } }),
  ]);
  try {
    expect.soft(hasOwnedWork()).toBe(true);
    const owned = followup(ownedTarget);
    const params = {
      key,
      agentId,
      ...(method === "sessions.patch" ? { archived: true, expectedSessionId: targetId } : {}),
    };
    await gateway()(method, params);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(foreign.settled).not.toHaveBeenCalled();
    expect(owned.settled).toHaveBeenCalledOnce();
    expect(FOLLOWUP_QUEUES.get(key)?.items).toEqual([foreign.run]);
    expect(hasOwnedWork()).toBe(false);
    const entry = loadSessionEntry({ agentId, sessionKey: target.canonicalKey });
    if (method === "sessions.delete") {
      expect(entry).toBeUndefined();
    } else if (method === "sessions.reset") {
      expect(entry?.lifecycleRevision).not.toBe("original");
    } else {
      expect(entry?.archivedAt).toEqual(expect.any(Number));
    }
    release.resolve();
    await blocker;
    expect(await queuedResult).toEqual([
      { status: "fulfilled", value: "preserved" },
      { status: "rejected", reason: expect.objectContaining({ name: "CommandLaneClearedError" }) },
    ]);
    expect(foreignTask).toHaveBeenCalledOnce();
    expect(ownedTask).not.toHaveBeenCalled();
    operation.complete();
    expect(operation.result?.kind).toBe("completed");
  } finally {
    operation.complete();
    release.resolve();
    [key, target.canonicalKey, targetId].forEach(clearFollowupQueueForTest);
    clearCommandLane(lane);
    await Promise.allSettled([blocker, queuedResult]);
  }
});

it.each(["sessions.delete", "sessions.reset", "sessions.patch"])(
  "%s still cancels the selected agent's own session",
  async (method) => {
    const key = "agent:main:lifecycle-owned";
    const sessionId = "owned-session";
    await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, { sessionId, updatedAt: 1 });
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId,
      agentId: "main",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
    try {
      const params = {
        key,
        ...(method === "sessions.patch" ? { archived: true, expectedSessionId: sessionId } : {}),
      };
      await gateway()(method, params);
      expect(operation.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
      [key, sessionId].forEach(clearFollowupQueueForTest);
    }
  },
);
