import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import {
  clearSessionQueues,
  hasSessionLifecycleQueueWork,
} from "../../auto-reply/reply/queue/cleanup.js";
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
import { resolveGatewaySessionStoreTarget } from "../session-utils.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

useChatAbortRegistryFixture();

it.each([
  { method: "sessions.delete", key: "global", agentId: "research" },
  { method: "sessions.reset", key: "global", agentId: "research" },
  { method: "sessions.delete", key: "shared", agentId: "research" },
  { method: "sessions.reset", key: "shared", agentId: "research" },
  { method: "sessions.patch", key: "shared", agentId: "research" },
  { method: "sessions.reset", key: "global", agentId: "main" },
  { method: "sessions.delete", key: "shared", agentId: "main" },
])("$method preserves another agent's $key work ($agentId)", async ({ method, key, agentId }) => {
  const cfg = {
    ...getRuntimeConfig(),
    agents: {
      ...getRuntimeConfig().agents,
      entries: { main: { default: true }, research: {} },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const foreignAgentId = agentId === "main" ? "research" : "main";
  const target = resolveGatewaySessionStoreTarget({ cfg, key, agentId });
  const targetId = `${agentId}-session`;
  const foreignId = `${foreignAgentId}-session`;
  await upsertSessionEntryCore(
    { agentId, sessionKey: target.canonicalKey },
    { sessionId: targetId, lifecycleRevision: "original", updatedAt: 1 },
  );
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId: foreignId,
    agentId: foreignAgentId,
    resetTriggered: false,
  });
  operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
  const queueKeys = [key, target.canonicalKey, targetId];
  const followup = (ownerAgentId: string, sessionId: string, sessionKey: string) => {
    const run = createQueueTestRun({ prompt: ownerAgentId });
    Object.assign(run.run, { agentId: ownerAgentId, sessionId, sessionKey });
    const settled = vi.fn();
    run.turnAdoptionLifecycle = {
      admission: "cancel-only",
      onAdopted: () => {},
      onSettled: settled,
    };
    enqueueFollowupRun(key, run, createQueueSettings(), "none", undefined, false);
    return { run, settled };
  };
  const foreign = followup(foreignAgentId, foreignId, key);
  const entered = createDeferred();
  const release = createDeferred();
  const lane = resolveEmbeddedSessionLane(key);
  const blocker = enqueueCommandInLane(lane, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const foreignTask = vi.fn(async () => "preserved");
  const queued = enqueueCommandInLane(lane, foreignTask, {
    sessionTarget: { agentId: foreignAgentId, sessionKey: key, sessionId: foreignId },
  });
  const queuedResult = Promise.allSettled([queued]);
  const ownedTask = vi.fn(async () => "must not run");
  const ownedQueued = enqueueCommandInLane(lane, ownedTask, {
    sessionTarget: { agentId, sessionKey: key, sessionId: targetId },
  });
  const ownedResult = Promise.allSettled([ownedQueued]);
  try {
    expect
      .soft(
        hasSessionLifecycleQueueWork({
          keys: [key],
          agentId,
          sessionKey: target.canonicalKey,
          sessionId: targetId,
        }),
      )
      .toBe(true);
    const owned = followup(agentId, targetId, target.canonicalKey);
    const respond = vi.fn();
    const params = {
      key,
      agentId,
      ...(method === "sessions.patch" ? { archived: true, expectedSessionId: targetId } : {}),
    };
    await handleGatewayRequest({
      req: { type: "req", id: "lifecycle-scope", method, params },
      client: sharingPolicyClient({
        user: ensureProfileForEmail("operator@example.test").id,
        scopes: ["operator.admin"],
      }),
      context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { ...sessionDeleteHandlers, ...sessionMutationHandlers },
    });
    expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0])).toBe(true);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(foreign.settled).not.toHaveBeenCalled();
    expect(owned.settled).toHaveBeenCalledOnce();
    expect(FOLLOWUP_QUEUES.get(key)?.items).toEqual([foreign.run]);
    expect(
      hasSessionLifecycleQueueWork({
        keys: [key],
        agentId,
        sessionKey: target.canonicalKey,
        sessionId: targetId,
      }),
    ).toBe(false);
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
    expect(await queuedResult).toEqual([{ status: "fulfilled", value: "preserved" }]);
    expect(foreignTask).toHaveBeenCalledOnce();
    expect(await ownedResult).toEqual([
      { status: "rejected", reason: expect.objectContaining({ name: "CommandLaneClearedError" }) },
    ]);
    expect(ownedTask).not.toHaveBeenCalled();
    operation.complete();
    expect(operation.result?.kind).toBe("completed");
  } finally {
    operation.complete();
    release.resolve();
    clearSessionQueues(queueKeys);
    clearCommandLane(lane);
    await Promise.allSettled([blocker, queuedResult, ownedResult]);
  }
});

it.each(["sessions.delete", "sessions.reset", "sessions.patch"])(
  "%s still cancels the selected agent's own session",
  async (method) => {
    const key = "agent:main:lifecycle-owned";
    const sessionId = "owned-session";
    const cfg = getRuntimeConfig();
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
      const respond = vi.fn();
      const params = {
        key,
        ...(method === "sessions.patch" ? { archived: true, expectedSessionId: sessionId } : {}),
      };
      await handleGatewayRequest({
        req: { type: "req", id: "lifecycle-owned", method, params },
        client: sharingPolicyClient({
          user: ensureProfileForEmail("operator@example.test").id,
          scopes: ["operator.admin"],
        }),
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        respond,
        isWebchatConnect: () => false,
        extraHandlers: { ...sessionDeleteHandlers, ...sessionMutationHandlers },
      });
      expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0])).toBe(true);
      expect(operation.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
      clearSessionQueues([key, sessionId]);
    }
  },
);
