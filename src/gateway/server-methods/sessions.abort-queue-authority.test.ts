// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { getExistingFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { enqueueCommandInLane, getQueueSize } from "../../process/command-queue.js";
import {
  retireSessionControllerInput,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { getRpcSource, registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { revocableAuthority } from "./sessions.abort-lifecycle.test-support.js";

useChatAbortRegistryFixture();
const key = "agent:main:queued-stop";
const sessionId = "original-stop-session";
const ownedFollowups: ReturnType<typeof createQueueTestRun>[] = [];
const readQueue = () =>
  getExistingFollowupQueue(key, ownedFollowups[0]?.controllerInput?.mailbox.owner.target);
afterEach(async () => {
  const inputs = ownedFollowups.splice(0).flatMap((run) => run.controllerInput ?? []);
  for (const input of inputs) {
    retireSessionControllerInput(input);
  }
  await Promise.allSettled(inputs.map((input) => input.settlement.promise));
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
    runId: "active",
    agentId: "main",
    sessionId,
    owner: { connId: client.connId },
  });
  // This fixture has no native producer: its synthetic turn returns on cancellation.
  active.input.abortSignal.addEventListener(
    "abort",
    () => {
      const claim = active.input.claim;
      claim?.operation?.complete();
      if (claim) {
        releaseSessionControllerClaim(claim);
      }
    },
    { once: true },
  );
  const queued = createActiveRun(key, {
    runId: "queued",
    queued: true,
    agentId: "main",
    sessionId,
    owner: { connId: client.connId },
  });
  registerRpcSource("active", active);
  registerRpcSource("queued", queued);
  const authority = revocableAuthority("original queue authority revoked");
  const respond = vi.fn();
  const stop = () =>
    handleGatewayRequest({
      req: gatewayRequest("ui-stop", "sessions.abort", { key, clearQueued: true }),
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      sessionMutationCommitGuard: authority.assertCurrent,
      extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
    });
  return {
    client,
    context,
    active,
    queued,
    respond,
    stop,
    revocationError: authority.error,
    revoke: authority.revoke,
  };
}

async function expectAuthorityRevocation(fixture: Awaited<ReturnType<typeof setup>>) {
  const failure = await fixture.stop().catch((error: unknown) => error);
  if (!(failure instanceof AggregateError)) {
    throw new Error("Expected cancellation and persistence failures", { cause: failure });
  }
  expect(failure.errors).toContain(fixture.revocationError);
}

function followup(
  prompt: string,
  targetSessionId = sessionId,
  agentId = "main",
  sessionKey = key,
  admissionSessionId?: string,
) {
  const run = createQueueTestRun({ prompt });
  ownedFollowups.push(run);
  Object.assign(run.run, { agentId, sessionKey, sessionId: targetSessionId });
  run.admissionSessionId = admissionSessionId;
  const settled = vi.fn();
  run.turnAdoptionLifecycle = { admission: "cancel-only", onAdopted: () => {}, onSettled: settled };
  enqueueFollowupRun(sessionKey, run, createQueueSettings(), "none", undefined, false);
  return { run, settled };
}

it("UI-style narrow Stop clears owned lane entries through their signals and preserves foreign work", async () => {
  const fixture = await setup();
  const foreign = createActiveRun(key, {
    runId: "foreign",
    queued: true,
    agentId: "main",
    sessionId: "previous-incarnation",
    owner: { connId: fixture.client.connId },
  });
  registerRpcSource("foreign", foreign);
  const ownFollowup = followup("owned");
  const foreignFollowup = followup("foreign", "previous-incarnation");
  const queue = readQueue();
  const lane = "test:sessions-abort-queue-authority";
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
    enqueueCommandInLane(lane, activeTask, { abortSignal: fixture.active.input.abortSignal }),
    enqueueCommandInLane(lane, queuedTask, { abortSignal: fixture.queued.input.abortSignal }),
    enqueueCommandInLane(lane, foreignTask, { abortSignal: foreign.input.abortSignal }),
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
    expect(fixture.active.input.abortSignal.aborted).toBe(true);
    expect(fixture.queued.input.abortSignal.aborted).toBe(true);
    expect(foreign.input.abortSignal.aborted).toBe(false);
    expect(getRpcSource("foreign")).toBe(foreign);
    expect(ownFollowup.settled).toHaveBeenCalledOnce();
    expect(foreignFollowup.settled).not.toHaveBeenCalled();
    expect(readQueue()).toBe(queue);
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
    const foreign = followup("main", "main-shared", "main", sharedKey);
    const owned = followup("research", researchSessionId, "research", sharedKey);
    const otherIncarnation = followup(
      "research",
      "research-previous",
      "research",
      sharedKey,
      "research-next",
    );
    try {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: gatewayRequest("research-shared-stop", "sessions.abort", {
          key: sharedKey,
          clearQueued: true,
        }),
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
        .soft(
          getExistingFollowupQueue(sharedKey, foreign.run.controllerInput?.mailbox.owner.target)
            ?.items,
          "main follow-up must remain queued",
        )
        .toEqual([foreign.run]);
    } finally {
      for (const run of [foreign.run, owned.run, otherIncarnation.run]) {
        const input = run.controllerInput;
        if (input) {
          retireSessionControllerInput(input);
          await input.settlement.promise.catch(() => {});
        }
      }
    }
  },
);

it.each(["session", "source"] as const)(
  "narrow clearQueued does not adopt %s changed by an earlier Stop callback",
  async (change) => {
    const fixture = await setup();
    const original = followup("original");
    const queue = expectDefined(readQueue(), "captured queue");
    fixture.queued.input.abortSignal.addEventListener(
      "abort",
      () => {
        if (change === "session") {
          original.run.run.sessionId = "successor-session";
        } else {
          fixture.revoke();
        }
      },
      { once: true },
    );
    if (change === "source") {
      await expectAuthorityRevocation(fixture);
    } else {
      await fixture.stop();
    }
    expect(fixture.queued.input.abortSignal.aborted).toBe(true);
    expect(fixture.active.input.abortSignal.aborted).toBe(change !== "source");
    expect(original.settled).not.toHaveBeenCalled();
    expect(readQueue()?.items).toEqual([original.run]);
    expect(queue.abortController.signal.aborted).toBe(false);
    if (change === "source") {
      expect(fixture.respond).not.toHaveBeenCalled();
    } else {
      expect(fixture.respond).toHaveBeenCalledOnce();
      expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
    }
  },
);

it("stops detached pending source cancellation after authority revocation", async () => {
  const fixture = await setup();
  const first = followup("first");
  const second = followup("second");
  first.settled.mockImplementation(() => {
    fixture.revoke();
    throw new Error("cleanup callback failed");
  });
  await expectAuthorityRevocation(fixture);
  expect(fixture.queued.input.abortSignal.aborted).toBe(true);
  expect(fixture.active.input.abortSignal.aborted).toBe(false);
  expect(first.settled).toHaveBeenCalledOnce();
  expect(second.settled).not.toHaveBeenCalled();
  await expect(first.run.controllerInput!.settlement.promise).rejects.toThrow(
    "cleanup callback failed",
  );
  expect(readQueue()?.items).toEqual([second.run]);
  expect(fixture.respond).not.toHaveBeenCalled();
});
