import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { FOLLOWUP_QUEUES } from "../../auto-reply/reply/queue/state.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { enqueueCommandInLane, getQueueSize } from "../../process/command-queue.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

useChatAbortRegistryFixture();
const key = "agent:main:queued-stop";
const sessionId = "original-stop-session";
afterEach(() => clearSessionQueues([key, sessionId]));

async function setup() {
  const client = roleClient("view", "queued-stop-owner");
  client.connId = "queued-stop-connection";
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: key },
    {
      sessionId,
      updatedAt: 1,
      createdActor: {
        type: "human",
        source: "profile",
        id: client.authenticatedUserProfile!.profileId,
      },
    },
  );
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const active = createActiveRun(key, {
    agentId: "main",
    sessionId,
    owner: { connId: client.connId },
  });
  const queued = createActiveRun(key, {
    agentId: "main",
    sessionId,
    owner: { connId: client.connId },
  });
  context.chatAbortControllers.set("active", active);
  context.chatQueuedTurns.set("queued", queued);
  let current = true;
  const respond = vi.fn();
  const stop = () =>
    handleGatewayRequest({
      req: {
        type: "req",
        id: "ui-stop",
        method: "sessions.abort",
        params: { key, clearQueued: true },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      sessionMutationCommitGuard: () => {
        if (!current) {
          throw new Error("original queue authority revoked");
        }
      },
      extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
    });
  return {
    client,
    context,
    active,
    queued,
    respond,
    stop,
    revoke: () => {
      current = false;
    },
  };
}

function followup(prompt: string, targetSessionId = sessionId) {
  const run = createQueueTestRun({ prompt });
  Object.assign(run.run, { agentId: "main", sessionKey: key, sessionId: targetSessionId });
  const settled = vi.fn();
  run.turnAdoptionLifecycle = { admission: "cancel-only", onAdopted: () => {}, onSettled: settled };
  enqueueFollowupRun(key, run, createQueueSettings(), "none", undefined, false);
  return { run, settled };
}

it("UI-style narrow Stop clears owned lane entries through their signals and preserves foreign work", async () => {
  const fixture = await setup();
  const foreign = createActiveRun(key, {
    agentId: "main",
    sessionId: "previous-incarnation",
    owner: { connId: fixture.client.connId },
  });
  fixture.context.chatQueuedTurns.set("foreign", foreign);
  const ownFollowup = followup("owned");
  const foreignFollowup = followup("foreign", "previous-incarnation");
  const queue = FOLLOWUP_QUEUES.get(key);
  const lane = resolveEmbeddedSessionLane(key);
  const entered = createDeferred();
  const release = createDeferred();
  const blocker = enqueueCommandInLane(lane, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const activeTask = vi.fn(async () => "active");
  const queuedTask = vi.fn(async () => "queued");
  const foreignTask = vi.fn(async () => "foreign");
  const maintenanceTask = vi.fn(async () => "maintenance");
  const queuedTasks = [
    enqueueCommandInLane(lane, activeTask, { abortSignal: fixture.active.controller.signal }),
    enqueueCommandInLane(lane, queuedTask, { abortSignal: fixture.queued.controller.signal }),
    enqueueCommandInLane(lane, foreignTask, { abortSignal: foreign.controller.signal }),
    enqueueCommandInLane(lane, maintenanceTask),
  ];
  const settled = Promise.allSettled(queuedTasks);
  try {
    await fixture.stop();
    expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
      true,
      { ok: true, abortedRunId: "queued", status: "aborted" },
      undefined,
    ]);
    expect(fixture.active.controller.signal.aborted).toBe(true);
    expect(fixture.queued.controller.signal.aborted).toBe(true);
    expect(foreign.controller.signal.aborted).toBe(false);
    expect(fixture.context.chatQueuedTurns.get("foreign")).toBe(foreign);
    expect(ownFollowup.settled).toHaveBeenCalledOnce();
    expect(foreignFollowup.settled).not.toHaveBeenCalled();
    expect(FOLLOWUP_QUEUES.get(key)).toBe(queue);
    expect(queue?.items).toEqual([foreignFollowup.run]);
    expect(queue?.abortController.signal.aborted).toBe(false);
    expect(getQueueSize(lane)).toBe(3);
    expect(activeTask).not.toHaveBeenCalled();
    expect(queuedTask).not.toHaveBeenCalled();
    release.resolve();
    await blocker;
    expect((await settled).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(foreignTask).toHaveBeenCalledOnce();
    expect(maintenanceTask).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await Promise.allSettled([blocker, ...queuedTasks]);
  }
});

it.each(["session", "queue", "new-source", "source"] as const)(
  "narrow clearQueued does not adopt %s changed by an earlier Stop callback",
  async (change) => {
    const fixture = await setup();
    const original = followup("original");
    const queue = expectDefined(FOLLOWUP_QUEUES.get(key), "captured queue");
    let successor: ReturnType<typeof followup> | undefined;
    fixture.queued.controller.signal.addEventListener(
      "abort",
      () => {
        if (change === "session") {
          original.run.run.sessionId = "successor-session";
        } else if (change === "queue") {
          FOLLOWUP_QUEUES.delete(key);
          successor = followup("successor queue");
        } else if (change === "new-source") {
          successor = followup("later source");
        } else {
          fixture.revoke();
        }
      },
      { once: true },
    );
    if (change === "source") {
      await expect(fixture.stop()).rejects.toThrow("original queue authority revoked");
    } else {
      await fixture.stop();
    }
    expect(fixture.queued.controller.signal.aborted).toBe(true);
    expect(fixture.active.controller.signal.aborted).toBe(change !== "source");
    expect(original.settled).toHaveBeenCalledTimes(change === "new-source" ? 1 : 0);
    expect(successor?.settled.mock.calls ?? []).toHaveLength(0);
    expect(FOLLOWUP_QUEUES.get(key)?.items).toEqual([successor?.run ?? original.run]);
    expect(queue.abortController.signal.aborted).toBe(false);
    if (change === "source") {
      expect(fixture.respond).not.toHaveBeenCalled();
    } else {
      expect(fixture.respond).toHaveBeenCalledOnce();
      expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
    }
  },
);

it("settles detached pending sources after revocation and preserves later active Stop effects", async () => {
  const fixture = await setup();
  const first = followup("first");
  const second = followup("second");
  first.settled.mockImplementation(() => {
    fixture.revoke();
    throw new Error("cleanup callback failed");
  });
  await expect(fixture.stop()).rejects.toThrow("original queue authority revoked");
  expect(fixture.queued.controller.signal.aborted).toBe(true);
  expect(fixture.active.controller.signal.aborted).toBe(false);
  expect(first.settled).toHaveBeenCalledOnce();
  expect(second.settled).toHaveBeenCalledOnce();
  expect(FOLLOWUP_QUEUES.get(key)?.items).toEqual([]);
  expect(fixture.respond).not.toHaveBeenCalled();
});
