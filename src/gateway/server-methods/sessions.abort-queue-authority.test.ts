// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { clearFollowupDrainCallback } from "../../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue, FOLLOWUP_QUEUES } from "../../auto-reply/reply/queue/state.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getQueueSize,
} from "../../process/command-queue.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

useChatAbortRegistryFixture();
const key = "agent:main:queued-stop";
const sessionId = "original-stop-session";
afterEach(() => {
  for (const queueKey of [key, sessionId]) {
    clearFollowupQueue(queueKey);
    clearFollowupDrainCallback(queueKey);
    clearCommandLane(resolveEmbeddedSessionLane(queueKey));
  }
});

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

it.each([true, false])(
  "broad research Stop preserves main's work sharing a bare session key (persisted=%s)",
  async (persisted) => {
    const sharedKey = "shared";
    const canonicalKey = "agent:research:shared";
    const researchSessionId = "research-shared";
    const cfg = {
      ...getRuntimeConfig(),
      agents: {
        entries: { main: {}, research: {} },
        ownership: "explicit" as const,
        defaults: { ...getRuntimeConfig().agents?.defaults, systemAgent: { agentId: "research" } },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    if (persisted) {
      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: canonicalKey },
        { sessionId: researchSessionId, updatedAt: 1 },
      );
    }
    const enqueueSharedFollowup = (
      agentId: string,
      targetSessionId: string,
      admissionSessionId?: string,
    ) => {
      const run = createQueueTestRun({ prompt: agentId });
      Object.assign(run.run, { agentId, sessionKey: sharedKey, sessionId: targetSessionId });
      run.admissionSessionId = admissionSessionId;
      const settled = vi.fn();
      run.turnAdoptionLifecycle = {
        admission: "cancel-only",
        onAdopted: () => {},
        onSettled: settled,
      };
      enqueueFollowupRun(sharedKey, run, createQueueSettings(), "none", undefined, false);
      return { run, settled };
    };
    const foreign = enqueueSharedFollowup("main", "main-shared");
    const owned = enqueueSharedFollowup("research", researchSessionId);
    const otherIncarnation = enqueueSharedFollowup(
      "research",
      "research-previous",
      "research-next",
    );
    const entered = createDeferred();
    const release = createDeferred();
    const lane = resolveEmbeddedSessionLane(sharedKey);
    const blocker = enqueueCommandInLane(lane, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const commands = [
      enqueueCommandInLane(lane, async () => "main tagged", {
        sessionTarget: { agentId: "main", sessionKey: sharedKey, sessionId: "main-shared" },
      }),
      enqueueCommandInLane(lane, async () => "main untagged"),
      enqueueCommandInLane(lane, async () => "research", {
        sessionTarget: { agentId: "research", sessionKey: sharedKey, sessionId: researchSessionId },
      }),
      enqueueCommandInLane(lane, async () => "research previous", {
        sessionTarget: {
          agentId: "research",
          sessionKey: sharedKey,
          sessionId: "research-previous",
        },
      }),
    ];
    const settled = Promise.allSettled(commands);
    try {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "research-shared-stop",
          method: "sessions.abort",
          params: { key: sharedKey, clearQueued: true },
        },
        client: sharingPolicyClient({ scopes: ["operator.admin"] }),
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        respond,
        isWebchatConnect: () => false,
        extraHandlers: sessionAbortHandlers,
      });
      expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0])).toBe(true);
      expect.soft(foreign.run.queueAbortSignal?.aborted, "main follow-up must survive").toBe(false);
      expect.soft(foreign.settled).not.toHaveBeenCalled();
      expect(owned.settled).toHaveBeenCalledOnce();
      expect(otherIncarnation.settled).toHaveBeenCalledOnce();
      expect
        .soft(FOLLOWUP_QUEUES.get(sharedKey)?.items, "main follow-up must remain queued")
        .toEqual([foreign.run]);
      release.resolve();
      await blocker;
      expect(await settled).toEqual([
        { status: "fulfilled", value: "main tagged" },
        { status: "fulfilled", value: "main untagged" },
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "CommandLaneClearedError" }),
        },
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "CommandLaneClearedError" }),
        },
      ]);
    } finally {
      release.resolve();
      for (const queueKey of [sharedKey, canonicalKey, researchSessionId]) {
        clearFollowupQueue(queueKey);
        clearFollowupDrainCallback(queueKey);
      }
      clearCommandLane(lane);
      await Promise.allSettled([blocker, settled]);
    }
  },
);

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
