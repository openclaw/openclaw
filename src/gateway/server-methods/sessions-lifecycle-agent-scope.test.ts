import { expect, it, vi } from "vitest";
import {
  createArchivedSubagentSweeperRun,
  createSubagentSweeperHarness,
} from "../../agents/subagents/registry/subagent-registry-sweeper.test-support.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { getExistingFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
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

function resolveTarget(key: string, agentId: string) {
  return resolveGatewaySessionStoreTargetInWorker({
    cfg: getRuntimeConfig(),
    key,
    agentId,
    projection: "list",
    exactRead: true,
    readOnly: false,
  });
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

it("sweep removes the recorded raw child owner without deleting another agent's global session", async () => {
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
  const h = createSubagentSweeperHarness(entry);
  h.callGateway.mockImplementation(async (request) => {
    await request.prepareDispatchCurrent?.();
    request.assertDispatchCurrent?.();
    return call(request.method, request.params);
  });
  try {
    await h.sweeper.sweepOnce();
    expect(h.runs.has(entry.runId)).toBe(false);
    expect(loadSessionEntry({ agentId: "research", sessionKey: "global" })).toBeUndefined();
    expect(loadSessionEntry({ agentId: "main", sessionKey: "global" })).toEqual(mainBefore);
  } finally {
    await h.sweeper.reset();
  }
});

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
  const target = await resolveTarget(key, agentId);
  const foreignTarget = await resolveTarget(key, foreignAgentId);
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
    target: captureSessionTarget({
      storeScope: foreignTarget.storePath,
      sessionKey: foreignTarget.canonicalKey,
      aliases: [key, ...foreignTarget.storeKeys],
      incarnation: foreignId,
      agentId: foreignAgentId,
    }),
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
  let owned: ReturnType<typeof followup> | undefined;
  try {
    owned = followup(agentId, targetId, target.canonicalKey);
    await gateway()(method, {
      key,
      agentId,
      ...(method === "sessions.patch" ? { archived: true, expectedSessionId: targetId } : {}),
    });
    expect(operation.abortSignal.aborted).toBe(false);
    expect(foreign.settled).not.toHaveBeenCalled();
    expect(owned.settled).toHaveBeenCalledOnce();
    expect(
      getExistingFollowupQueue(key, foreign.run.controllerInput?.mailbox.owner.target)?.items,
    ).toEqual([foreign.run]);
    const entry = loadSessionEntry({ agentId, sessionKey: target.canonicalKey });
    if (method === "sessions.delete") {
      expect(entry).toBeUndefined();
    } else if (method === "sessions.reset") {
      expect(entry?.lifecycleRevision).not.toBe("original");
    } else {
      expect(entry?.archivedAt).toEqual(expect.any(Number));
    }
    operation.complete();
    expect(operation.result?.kind).toBe("completed");
  } finally {
    operation.complete();
    clearSessionQueues(queueKeys, foreign.run.controllerInput?.mailbox.owner.target);
    if (owned?.run.controllerInput?.mailbox.owner.target) {
      clearSessionQueues(queueKeys, owned.run.controllerInput.mailbox.owner.target);
    }
  }
});
