import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { killAllControlledSubagentRuns } from "../agents/subagents/registry/subagent-control-kill.js";
import { resolveSubagentController } from "../agents/subagents/registry/subagent-control-scope.js";
import * as sessionTiming from "../agents/subagents/registry/subagent-registry-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { createSubagentRegistryRestorer } from "../agents/subagents/registry/subagent-registry-restore.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import * as subagentRegistry from "../agents/subagents/registry/subagent-registry.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  closeSwarmScheduler,
  holdQueuedSwarmRun,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runWithChatAbortExecution } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const { parentKey, createQueuedReservation, requestContext, operatorClient } =
  useQueuedCollectorFixture();

it("keeps restored queued cancellation unqualified without retained preparation ownership", async () => {
  const { entry } = await createQueuedReservation("restored");
  expect(removeQueuedSwarmRun(entry.runId)).toBe(true);
  entry.queuedLaunch = {
    request: { sessionKey: entry.childSessionKey, idempotencyKey: entry.runId },
    timeoutMs: 100,
    schedulerGroupKey: entry.groupId!,
    maxConcurrent: 1,
  };
  const startQueued = vi.fn(() => true);
  const cleanupResources = vi.fn(async () => true);
  const restorer = createSubagentRegistryRestorer({
    runs: subagentRuns,
    getGatewayContextResolver: () => undefined,
    bindGatewayOwners: () => true,
    persist: () => {},
    persistOrThrow: () => {},
    settleRequesterTurn: () => false,
    ensureListener: () => {},
    startSweeper: () => {},
    scheduleSweep: () => {},
    resumeRun: () => {},
    listSwarmRunsForGroup: () => [entry],
    startQueuedSubagentRun: startQueued,
    terminateAcceptedRestoredCollectorRun: async () => {},
    cleanupCollectorLaunchResources: cleanupResources,
    settleFailedQueuedSubagentLaunch: () => true,
    completeCollectorLaunchCleanup: () => {},
    warn: () => {},
  });
  restorer.restoreOnce();
  restorer.activate();
  const hold = expectDefined(holdQueuedSwarmRun(entry.runId), "restored reservation");
  const respond = vi.fn();
  try {
    await expectDefined(
      sessionAbortHandlers["sessions.abort"],
      "Stop handler",
    )({
      req: { type: "req", id: "restored-queued-stop", method: "sessions.abort" },
      params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
      client: operatorClient(),
      isWebchatConnect: () => false,
      context: requestContext(),
      respond,
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(startQueued).not.toHaveBeenCalled();
    expect(cleanupResources).not.toHaveBeenCalled();
    await expect(hold.settleCancellation()).resolves.toBe(false);
    const stored = expectDefined(
      loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry,
      "restored terminal session",
    );
    expect(stored.status).toBe("killed");
    // A queued descriptor can also survive a lost prior dispatch response. Neither
    // this new reservation nor empty session markers establish its old preparation.
    expect(stored.lastRunId).toBeUndefined();
    expect(stored.startedAt).toBeUndefined();
    expect(stored.runtimeMs).toBeUndefined();
  } finally {
    await hold.release();
    restorer.reset();
  }
});

it.each([
  "settled",
  "rejected",
  "session replaced",
  "run replaced",
  "successor terminal",
  "authority revoked",
  "shutdown",
] as const)("publishes queued cancellation only after owned cleanup: %s", async (transition) => {
  const { entry, registration } = await createQueuedReservation();
  const producer = expectDefined(holdQueuedSwarmRun(entry.runId), "preparation hold");
  const entered = createDeferred();
  const release = createDeferred();
  const failure = new Error("owned queued cleanup failed");
  const start = vi.fn(async () => {});
  const cleanup = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    if (transition === "rejected") {
      throw failure;
    }
  });
  activateSwarmRun({
    groupId: entry.groupId!,
    runId: entry.runId,
    start,
    onStartFailure: () => true,
    onRemoved: cleanup,
  });
  const context = requestContext();
  const respond = vi.fn();
  const stopping = Promise.resolve(
    expectDefined(
      sessionAbortHandlers["sessions.abort"],
      "Stop handler",
    )({
      req: { type: "req", id: "settled-queued-stop", method: "sessions.abort" },
      params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
      client: operatorClient(),
      isWebchatConnect: () => false,
      context,
      respond,
    }),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    // The owned callback has entered and is still holding its real cleanup work.
    expect(loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.lastRunId).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    if (transition === "session replaced") {
      const selected = loadGatewaySessionEntryReadOnly(entry.childSessionKey);
      await replaceSessionEntry(
        { storePath: selected.storePath, sessionKey: entry.childSessionKey },
        {
          ...expectDefined(selected.entry, "selected session"),
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-lifecycle",
          lastRunId: "replacement-terminal",
          status: "done",
          abortedLastRun: false,
        },
      );
    } else if (transition === "run replaced") {
      reserveSwarmRun({
        runId: entry.runId,
        groupId: entry.groupId!,
        maxConcurrent: 1,
        activeRunIds: [],
      });
      registerSubagentRun(registration);
    } else if (transition === "successor terminal") {
      const selected = loadGatewaySessionEntryReadOnly(entry.childSessionKey);
      await replaceSessionEntry(
        { storePath: selected.storePath, sessionKey: entry.childSessionKey },
        {
          ...expectDefined(selected.entry, "selected session"),
          lastRunId: "successor-terminal",
          status: "killed",
          endedAt: Date.now(),
        },
      );
    } else if (transition === "authority revoked") {
      context.chatAbortControllers.delete("parent-turn");
    } else if (transition === "shutdown") {
      closing = closeSwarmScheduler();
    }
  } finally {
    release.resolve();
  }
  const error = await stopping;
  await producer.release();
  await closing;
  const stored = expectDefined(
    loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry,
    "terminal session",
  );
  expect(start).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
  if (transition === "settled") {
    expect(error).toBeUndefined();
    expect(stored).toMatchObject({
      status: "killed",
      lastRunId: entry.runId,
      abortedLastRun: true,
    });
    expect(stored.startedAt).toBeUndefined();
    expect(stored.runtimeMs).toBeUndefined();
  } else if (transition === "session replaced") {
    expect(stored).toMatchObject({
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-lifecycle",
      lastRunId: "replacement-terminal",
    });
  } else if (transition === "successor terminal") {
    expect(stored.lastRunId).toBe("successor-terminal");
  } else {
    expect(stored.lastRunId).toBeUndefined();
  }
  if (transition === "rejected") {
    await expect(closeSwarmScheduler()).rejects.toMatchObject({ errors: [failure] });
    expect(error).toBeUndefined();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining(failure.message),
    });
  }
  if (transition === "authority revoked") {
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  }
});

it("joins sibling terminal publication before releasing custody after rejected cleanup", async () => {
  const failed = await createQueuedReservation("failed-cleanup");
  const sibling = await createQueuedReservation("held-publication");
  const holders = [failed, sibling].map(({ entry }) =>
    expectDefined(holdQueuedSwarmRun(entry.runId), "producer reservation"),
  );
  const failure = new Error("first selected cleanup failed");
  const rejectCleanup = createDeferred();
  const publicationEntered = createDeferred();
  const releasePublication = createDeferred();
  const order: string[] = [];
  for (const selected of [failed, sibling]) {
    activateSwarmRun({
      groupId: selected.entry.groupId!,
      runId: selected.entry.runId,
      start: async () => {
        throw new Error("held queued run must not start");
      },
      onStartFailure: () => true,
      onRemoved: async () => {
        if (selected === failed) {
          await rejectCleanup.promise;
          throw failure;
        }
      },
    });
  }
  const persist = sessionTiming.persistSubagentSessionTiming;
  const timingSpy = vi
    .spyOn(sessionTiming, "persistSubagentSessionTiming")
    .mockImplementation(async (entry, options) => {
      if (entry === sibling.entry && options?.settledQueuedCancellation) {
        publicationEntered.resolve();
        await releasePublication.promise;
        await persist(entry, options);
        order.push("publication joined");
        return;
      }
      await persist(entry, options);
    });
  const capture = subagentRuns.captureRetirement.bind(subagentRuns);
  const retirementSpy = vi
    .spyOn(subagentRuns, "captureRetirement")
    .mockImplementation((...args) => {
      const retirement = capture(...args);
      return {
        get observation() {
          return retirement.observation;
        },
        release: () => {
          order.push("custody released");
          retirement.release();
        },
      };
    });
  const cfg = getRuntimeConfig();
  const stopping = killAllControlledSubagentRuns({
    cfg,
    controller: resolveSubagentController({ cfg, agentSessionKey: parentKey }),
    runs: [failed.entry, sibling.entry],
  }).then(
    (result) => result,
    (error: unknown) => error,
  );
  try {
    await publicationEntered.promise;
    rejectCleanup.resolve();
    await expect(holders[0]!.settleCancellation()).rejects.toBe(failure);
    releasePublication.resolve();
    expect(await stopping).toBe(failure);
    expect(order[0]).toBe("publication joined");
    expect(order.filter((event) => event === "custody released")).toHaveLength(2);
    expect(loadGatewaySessionEntryReadOnly(sibling.entry.childSessionKey).entry?.lastRunId).toBe(
      sibling.entry.runId,
    );
    expect(
      loadGatewaySessionEntryReadOnly(failed.entry.childSessionKey).entry?.lastRunId,
    ).toBeUndefined();
  } finally {
    rejectCleanup.resolve();
    releasePublication.resolve();
    await stopping;
    await Promise.all(holders.map((hold) => hold.release()));
    timingSpy.mockRestore();
    retirementSpy.mockRestore();
    await expect(closeSwarmScheduler()).rejects.toMatchObject({ errors: [failure] });
  }
});

it.each(["settled", "rejected", "controller replaced", "authority revoked"] as const)(
  "late Stop joins the exact raw execution outside its mutation: %s",
  async (transition) => {
    const { entry } = await createQueuedReservation("raw-tail");
    const context = requestContext();
    bindGatewayContextResolver(entry, () => context);
    const selected = loadGatewaySessionEntryReadOnly(entry.childSessionKey);
    const sessionId = expectDefined(selected.entry?.sessionId, "child session");
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      sessionId,
      agentId: "main",
      kind: "agent",
      operationalRunInstance: createOperationalRunInstanceRef(entry.runId),
      timeoutMs: 60_000,
    });
    const owner = expectDefined(registration.entry, "raw execution owner");
    const producer = expectDefined(holdQueuedSwarmRun(entry.runId), "producer hold");
    const withdrawn = createDeferred();
    const nested = createDeferred();
    const dispose = createDeferred();
    const order: string[] = [];
    const failure = new Error("raw runtime disposal failed");
    const retirement = subagentRuns.captureRetirement.bind(subagentRuns);
    const observeRetirement = vi
      .spyOn(subagentRuns, "captureRetirement")
      .mockImplementation((...args) => {
        const captured = retirement(...args);
        return {
          get observation() {
            return captured.observation;
          },
          release() {
            order.push("custody released");
            captured.release();
          },
        };
      });
    const execution = runWithChatAbortExecution(
      owner,
      async () => {
        registration.cleanup();
        await withdrawn.promise;
        await runExclusiveSessionLifecycleMutation({
          scope: selected.storePath,
          identities: [entry.childSessionKey, sessionId],
          run: async () => {
            nested.resolve();
          },
        });
        await dispose.promise;
        order.push("runtime disposed");
        if (transition === "rejected") {
          throw failure;
        }
      },
      registration.cleanup,
    ).catch((error: unknown) => error);
    const selectedTail = createDeferred();
    const settlement = expectDefined(owner.executionSettlement, "execution settlement");
    const completion = settlement.completion;
    Object.defineProperty(settlement, "completion", {
      get() {
        selectedTail.resolve();
        return completion;
      },
    });
    activateSwarmRun({
      groupId: entry.groupId!,
      runId: entry.runId,
      start: async () => {
        throw new Error("cancelled launch ran");
      },
      onStartFailure: () => true,
      onRemoved: async () => {
        withdrawn.resolve();
      },
    });
    const respond = vi.fn();
    const stopping = Promise.resolve(
      expectDefined(
        sessionAbortHandlers["sessions.abort"],
        "Stop",
      )({
        req: { type: "req", id: "raw-tail-stop", method: "sessions.abort" },
        params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
        client: operatorClient(),
        isWebchatConnect: () => false,
        context,
        respond,
      }),
    ).catch((error: unknown) => error);
    try {
      expect(
        await Promise.race([
          selectedTail.promise.then(() => "tail selected"),
          stopping.then(() => "Stop returned"),
        ]),
      ).toBe("tail selected");
      await nested.promise;
      expect(owner.registrationCleanupRequested).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      expect(order).toEqual([]);
      if (transition === "controller replaced") {
        context.chatAbortControllers.delete(entry.runId);
        registerChatAbortController({
          chatAbortControllers: context.chatAbortControllers,
          runId: entry.runId,
          sessionKey: entry.childSessionKey,
          sessionId,
          kind: "agent",
          timeoutMs: 60_000,
        });
      } else if (transition === "authority revoked") {
        context.chatAbortControllers.delete("parent-turn");
      }
      dispose.resolve();
      await stopping;
      await execution;
      expect(order[0]).toBe("runtime disposed");
      expect(order).toContain("custody released");
      if (transition === "settled") {
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      } else if (
        transition === "rejected" ||
        transition === "authority revoked" ||
        transition === "controller replaced"
      ) {
        expect(
          loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.lastRunId,
        ).toBeUndefined();
      }
      if (transition === "controller replaced") {
        expect(context.chatAbortControllers.get(entry.runId)).not.toBe(owner);
      }
    } finally {
      withdrawn.resolve();
      dispose.resolve();
      await Promise.allSettled([stopping, execution]);
      await producer.release();
      observeRetirement.mockRestore();
      context.chatAbortControllers.clear();
    }
  },
);

it("in-band Stop excludes its own exact execution without certifying pending disposal", async () => {
  const { entry } = await createQueuedReservation("self-stop");
  const context = requestContext();
  bindGatewayContextResolver(entry, () => context);
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    sessionId: expectDefined(
      loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.sessionId,
      "session",
    ),
    kind: "agent",
    timeoutMs: 60_000,
  });
  const owner = expectDefined(registration.entry, "own execution");
  const respond = vi.fn();
  await runWithChatAbortExecution(
    owner,
    async () => {
      await expectDefined(
        sessionAbortHandlers["sessions.abort"],
        "Stop",
      )({
        req: { type: "req", id: "self-stop", method: "sessions.abort" },
        params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
        context,
        respond,
        client: operatorClient(),
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(owner.executionSettlement?.status).toBe("pending");
      expect(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.lastRunId,
      ).toBeUndefined();
      registration.cleanup();
    },
    registration.cleanup,
  );
  expect(context.chatAbortControllers.has(entry.runId)).toBe(false);
});

it.each([false, true])(
  "a replacement local owner cannot qualify an unknown restored attempt (started=%s)",
  async (started) => {
    const { entry } = await createQueuedReservation("restored-replacement");
    expect(removeQueuedSwarmRun(entry.runId)).toBe(true);
    // This descriptor does not identify the original physical attempt. A newly
    // accepted local incarnation with identical logical IDs cannot supply it.
    entry.queuedLaunch = {
      request: { sessionKey: entry.childSessionKey, idempotencyKey: entry.runId },
      timeoutMs: 100,
      schedulerGroupKey: entry.groupId!,
      maxConcurrent: 1,
    };
    const context = requestContext();
    bindGatewayContextResolver(entry, () => context);
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      sessionId: expectDefined(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.sessionId,
        "session",
      ),
      kind: "agent",
      operationalRunInstance: createOperationalRunInstanceRef(entry.runId),
      timeoutMs: 60_000,
    });
    const owner = expectDefined(registration.entry, "replacement execution");
    if (started) {
      expect(registration.markExecutionStarted()).toBe(true);
    }
    const releaseExecution = createDeferred();
    const selectedTail = createDeferred();
    const execution = runWithChatAbortExecution(
      owner,
      async () => {
        registration.cleanup();
        await releaseExecution.promise;
      },
      registration.cleanup,
    );
    const settlement = expectDefined(owner.executionSettlement, "replacement settlement");
    const completion = settlement.completion;
    Object.defineProperty(settlement, "completion", {
      get() {
        selectedTail.resolve();
        return completion;
      },
    });
    const cleanupResources = vi.fn(async () => {
      throw new Error("unknown original cleanup owner");
    });
    const startQueued = vi.fn(() => true);
    const restorer = createSubagentRegistryRestorer({
      runs: subagentRuns,
      getGatewayContextResolver: () => () => context,
      bindGatewayOwners: () => true,
      persist: () => {},
      persistOrThrow: () => {},
      settleRequesterTurn: () => false,
      ensureListener: () => {},
      startSweeper: () => {},
      scheduleSweep: () => {},
      resumeRun: () => {},
      listSwarmRunsForGroup: () => [entry],
      startQueuedSubagentRun: startQueued,
      terminateAcceptedRestoredCollectorRun: async () => {
        throw new Error("unexpected restored launch");
      },
      cleanupCollectorLaunchResources: cleanupResources,
      settleFailedQueuedSubagentLaunch: () => true,
      completeCollectorLaunchCleanup: () => {},
      warn: () => {},
    });
    restorer.restoreOnce();
    restorer.activate();
    const hold = expectDefined(holdQueuedSwarmRun(entry.runId), "restored reservation");
    const respond = vi.fn();
    const stopping = Promise.resolve(
      expectDefined(
        sessionAbortHandlers["sessions.abort"],
        "Stop",
      )({
        req: { type: "req", id: "replacement-local-stop", method: "sessions.abort" },
        params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
        context,
        respond,
        client: operatorClient(),
        isWebchatConnect: () => false,
      }),
    ).catch((error: unknown) => error);
    try {
      expect(
        await Promise.race([
          selectedTail.promise.then(() => "tail selected"),
          stopping.then(() => "Stop returned"),
        ]),
      ).toBe("tail selected");
      expect(respond).not.toHaveBeenCalled();
      releaseExecution.resolve();
      await stopping;
      await execution;
      expect(startQueued).not.toHaveBeenCalled();
      expect(cleanupResources).not.toHaveBeenCalled();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.lastRunId,
      ).toBeUndefined();
      await expect(hold.settleCancellation()).resolves.toBe(false);
    } finally {
      releaseExecution.resolve();
      await Promise.allSettled([stopping, execution]);
      await hold.release();
      restorer.reset();
    }
  },
);

it.each([false, true])(
  "parent Stop retains a terminal child's tail when wake cancellation fails=%s",
  async (wakeFailure) => {
    const { entry } = await createQueuedReservation("terminal-tail");
    const context = requestContext();
    bindGatewayContextResolver(entry, () => context);
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      sessionId: expectDefined(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.sessionId,
        "session",
      ),
      kind: "agent",
      timeoutMs: 60_000,
    });
    const owner = expectDefined(registration.entry, "terminal tail owner");
    const releaseTail = createDeferred();
    const selectedTail = createDeferred();
    const execution = runWithChatAbortExecution(
      owner,
      async () => {
        if (!wakeFailure) {
          registration.cleanup();
        }
        await releaseTail.promise;
        registration.cleanup();
      },
      registration.cleanup,
    );
    const settlement = expectDefined(owner.executionSettlement, "terminal raw settlement");
    const completion = settlement.completion;
    Object.defineProperty(settlement, "completion", {
      get() {
        selectedTail.resolve();
        return completion;
      },
    });
    subagentRegistry.markSubagentRunTerminated({ runId: entry.runId, reason: "killed" });
    const wakeCancellation = wakeFailure
      ? vi
          .spyOn(subagentRegistry, "cancelSubagentRequesterSettleWake")
          .mockRejectedValue(new Error("wake cancellation failed"))
      : undefined;
    if (wakeFailure) {
      entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    }
    expect(entry.execution.endedAt).toBeDefined();
    if (wakeFailure) {
      expect(owner.registrationCleanupRequested).not.toBe(true);
      expect(owner.controller.signal.aborted).toBe(false);
    }
    const cfg = getRuntimeConfig();
    const stopping = killAllControlledSubagentRuns({
      cfg,
      controller: resolveSubagentController({ cfg, agentSessionKey: parentKey }),
      runs: [entry],
      suppressTaskDelivery: wakeFailure,
    });
    try {
      const first = await Promise.race([
        selectedTail.promise.then(() => "tail selected"),
        stopping.then(() => "Stop returned"),
      ]);
      if (wakeCancellation) {
        expect(wakeCancellation).toHaveBeenCalledOnce();
      }
      expect(first).toBe("tail selected");
      expect(owner.executionSettlement?.status).toBe("pending");
      releaseTail.resolve();
      await stopping;
      await execution;
      expect(context.chatAbortControllers.has(entry.runId)).toBe(false);
    } finally {
      releaseTail.resolve();
      await Promise.allSettled([stopping, execution]);
      wakeCancellation?.mockRestore();
    }
  },
);

it("refuses an exact Stop promptly when other session work prevents cancellation", async () => {
  const { entry } = await createQueuedReservation("declined-tail");
  const context = requestContext();
  bindGatewayContextResolver(entry, () => context);
  const sessionId = expectDefined(
    loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.sessionId,
    "session",
  );
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    sessionId,
    kind: "agent",
    ownerConnId: "parent-requester",
    timeoutMs: 60_000,
    operationalRunInstance: createOperationalRunInstanceRef(entry.runId),
  });
  const sibling = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: "other-session-work",
    sessionKey: entry.childSessionKey,
    sessionId,
    kind: "agent",
    ownerConnId: "parent-requester",
    timeoutMs: 60_000,
  });
  const owner = expectDefined(registration.entry, "active selected owner");
  const finish = createDeferred();
  const selectedTail = createDeferred();
  const execution = runWithChatAbortExecution(
    owner,
    async () => {
      await finish.promise;
      registration.cleanup();
    },
    registration.cleanup,
  );
  const settlement = expectDefined(owner.executionSettlement, "active execution");
  const completion = settlement.completion;
  Object.defineProperty(settlement, "completion", {
    get() {
      selectedTail.resolve();
      return completion;
    },
  });
  const respond = vi.fn();
  const stopping = Promise.resolve(
    expectDefined(
      sessionAbortHandlers["sessions.abort"],
      "Stop",
    )({
      req: { type: "req", id: "declined-tail-stop", method: "sessions.abort" },
      params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
      context,
      respond,
      client: operatorClient(),
      isWebchatConnect: () => false,
    }),
  ).catch((error: unknown) => error);
  try {
    expect(
      await Promise.race([
        stopping.then(() => "refused"),
        selectedTail.promise.then(() => "waited for active execution"),
      ]),
    ).toBe("refused");
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(owner.controller.signal.aborted).toBe(false);
    expect(sibling.controller.signal.aborted).toBe(false);
    expect(owner.executionSettlement?.status).toBe("pending");
    expect(entry.execution.status).toBe("queued");
  } finally {
    finish.resolve();
    await Promise.allSettled([stopping, execution]);
    sibling.cleanup();
  }
});

it.each([
  { mode: "bulk", retired: false },
  { mode: "exact", retired: false },
  { mode: "bulk", retired: true },
  { mode: "exact", retired: true },
] as const)(
  "$mode Stop still cancels captured descendants after parent disposal rejects (retired=$retired)",
  async ({ mode, retired }) => {
    const parent = await createQueuedReservation("rejected-parent");
    const child = await createQueuedReservation("captured-child", undefined, {
      sessionKey: parent.entry.childSessionKey,
      runId: parent.entry.runId,
    });
    const context = requestContext();
    bindGatewayContextResolver(parent.entry, () => context);
    const selected = loadGatewaySessionEntryReadOnly(parent.entry.childSessionKey);
    const sessionId = expectDefined(selected.entry?.sessionId, "parent session");
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: parent.entry.runId,
      sessionKey: parent.entry.childSessionKey,
      sessionId,
      kind: "agent",
      ownerConnId: "parent-requester",
      timeoutMs: 60_000,
    });
    const owner = expectDefined(registration.entry, "parent execution");
    const interrupted = createDeferred();
    const disposalEntered = createDeferred();
    const releaseDisposal = createDeferred();
    registration.controller.signal.addEventListener("abort", () => interrupted.resolve(), {
      once: true,
    });
    const admission = await beginSessionWorkAdmission({
      scope: selected.storePath,
      identities: [parent.entry.childSessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        registration.controller.abort();
        return { runId: parent.entry.runId };
      },
    });
    const failure = new Error("parent runtime disposal failed");
    const execution = runWithChatAbortExecution(
      owner,
      async () => {
        await interrupted.promise;
        registration.cleanup();
        admission.release();
        disposalEntered.resolve();
        await releaseDisposal.promise;
        throw failure;
      },
      registration.cleanup,
    ).catch((error: unknown) => error);
    const cfg = getRuntimeConfig();
    const respond = vi.fn();
    const stopping =
      mode === "bulk"
        ? killAllControlledSubagentRuns({
            cfg,
            controller: resolveSubagentController({ cfg, agentSessionKey: parentKey }),
            runs: [parent.entry],
          })
        : Promise.resolve(
            expectDefined(
              sessionAbortHandlers["sessions.abort"],
              "Stop",
            )({
              req: { type: "req", id: "parent-rejection-stop", method: "sessions.abort" },
              params: {
                key: parent.entry.childSessionKey,
                runId: parent.entry.runId,
                agentId: "main",
              },
              context,
              respond,
              client: operatorClient("parent-requester", retired),
              isWebchatConnect: () => false,
            }),
          );
    try {
      await disposalEntered.promise;
      expect(child.entry.execution.status).toBe("queued");
      if (retired) {
        // Exact Stop signals before committing its tombstone. Retire only after
        // that mutation releases the fence, while raw disposal remains pending.
        await runExclusiveSessionLifecycleMutation({
          scope: selected.storePath,
          identities: [parent.entry.childSessionKey, sessionId],
          run: async () => expect(parent.entry.execution.status).toBe("terminal"),
        });
        expect(subagentRuns.delete(parent.entry.runId)).toBe(true);
        await persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, [parent.entry.runId], {
          context: captureOpenClawStateWorkerContext(),
          assertCurrent: () => expect(subagentRuns.has(parent.entry.runId)).toBe(false),
          onCommitted: () => subagentRuns.confirmRetirement(parent.entry),
        });
      }
      releaseDisposal.resolve();
      await stopping;
      expect(await execution).toBe(failure);
      expect(child.entry.execution.status).toBe("terminal");
      expect(child.entry.endedReason).toBe("subagent-killed");
      if (mode === "exact") {
        expect(respond.mock.calls[0]?.[0]).toBe(false);
        expect(respond.mock.calls[0]?.[2]).toMatchObject({
          message: expect.stringContaining(failure.message),
        });
      } else {
        expect(await stopping).toMatchObject({
          status: "error",
          failed: 1,
          error: expect.stringContaining(failure.message),
        });
      }
    } finally {
      registration.controller.abort();
      releaseDisposal.resolve();
      admission.release();
      await Promise.allSettled([stopping, execution]);
      context.chatAbortControllers.clear();
    }
  },
);
