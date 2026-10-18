import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as subagentKill from "../agents/subagents/registry/subagent-control-kill.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentRunQueued } from "../agents/subagents/registry/subagent-registry-read.js";
import { loadSubagentSessionListRunsFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  claimSubagentRunKill,
  registerSubagentRun,
  releaseSubagentRun,
  releaseSubagentRunKillClaim,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { isSameSubagentRunOwner } from "../agents/subagents/registry/subagent-run-generation.js";
import * as nativeSpawn from "../agents/subagents/spawn/subagent-spawn.js";
import {
  activateSwarmRun,
  holdQueuedSwarmRun,
  releaseSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { captureAsyncWorkTracker } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { handleChatSend } from "./server-methods/chat-send-handler.js";
import { prepareAndAdmitChatSend } from "./server-methods/chat-send-setup.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import * as sessionStoreWorker from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";

const {
  parentKey,
  launchedRunIds,
  waitForLaunch,
  requestContext,
  operatorClient,
  requestOptions,
  listChildren,
  spawnCollectors,
  spawnCollector,
  createQueuedReservation,
  expectUnstartedChildHistory,
} = useQueuedCollectorFixture();

async function abortCollector(
  params: Record<string, unknown>,
  context = requestContext(),
  client = operatorClient(),
) {
  const options = requestOptions(context, "sessions.abort", params);
  options.client = client;
  await sessionAbortHandlers["sessions.abort"]!(options);
  return options.respond;
}
function expectAborted(respond: ReturnType<typeof vi.fn>, runId: string | undefined) {
  expect(respond).toHaveBeenCalledWith(
    true,
    { ok: true, status: "aborted", abortedRunId: runId },
    undefined,
    undefined,
  );
}

function expectRejected(
  respond: ReturnType<typeof vi.fn>,
  error: Record<string, unknown> = { code: expect.any(String) },
  soft = false,
) {
  (soft ? expect.soft(respond) : expect(respond)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining(error),
  );
}

function reserveAgain(entry: { runId: string; groupId?: string }) {
  reserveSwarmRun({
    runId: entry.runId,
    groupId: entry.groupId!,
    maxConcurrent: 1,
    activeRunIds: [],
  });
}

function gateRequesterRead(afterRead = false) {
  const gate = createDeferred();
  const read = sessionStoreWorker.resolveGatewaySessionStoreTargetInWorker;
  const spy = vi
    .spyOn(sessionStoreWorker, "resolveGatewaySessionStoreTargetInWorker")
    .mockImplementationOnce(async (params) => {
      const target = afterRead ? await read(params) : undefined;
      await gate.promise;
      return afterRead ? expectDefined(target, "prepared requester") : read(params);
    });
  return { gate, spy };
}

describe("queued collector session projection", () => {
  it("lists both labeled collectors before the second launches without inventing its runtime", async () => {
    const context = requestContext();
    const broadcast = vi.fn();
    const publications: Promise<void>[] = [];
    const trackPublication = captureAsyncWorkTracker();
    const publishLifecycle = createLifecycleEventBroadcastHandler({
      broadcastToConnIds: broadcast,
      sessionEventSubscribers: { getAll: () => new Set(["observer"]) },
      chatAbortControllers: context.chatAbortControllers,
      getSessionRowProjection: () => getSessionRowProjection(context),
    });
    const unsubscribe = onSessionLifecycleEvent((event) => {
      // The observer is joined by this fixture, not the short-lived launch that emits the event.
      publications.push(trackPublication(() => publishLifecycle(event)));
    });
    try {
      const results = await spawnCollectors();
      const first = expectDefined(results[0], "first collector");
      const second = expectDefined(results[1], "second collector");
      try {
        const rows = (await listChildren(context)).sessions;
        expect(rows.map((row) => row.key).toSorted()).toEqual(
          results
            .map((result) => expectDefined(result.childSessionKey, "accepted child key"))
            .toSorted(),
        );
        for (const [index, result] of results.entries()) {
          const row = expectDefined(
            rows.find((candidate) => candidate.key === result.childSessionKey),
            "collector session row",
          );
          expect.soft(row).toMatchObject({
            label: index === 0 ? "Collector A" : "Collector B",
            swarmGroupId: `swarm:${parentKey}:parent-turn`,
            subagentRunState: "active",
            hasActiveRun: true,
            status: index === 0 ? "running" : "queued",
          });
        }
        const queued = expectDefined(
          rows.find((row) => row.key === second.childSessionKey),
          "queued child",
        );
        expect.soft([queued.startedAt, queued.runtimeMs]).toEqual([undefined, undefined]);
        expect(queued.activeRunIds).toEqual([second.runId]);
        await expectUnstartedChildHistory(context, queued.key, [second.runId!]);
        await Promise.all(publications);
        // First observation can publish current facts instead of replaying the create reason.
        const published = broadcast.mock.calls.find(
          ([method, event]) =>
            method === "sessions.changed" &&
            event.sessionKey === second.childSessionKey &&
            (event.reason === "create" || event.reason === "updated"),
        )?.[1];
        expect.soft(published).toMatchObject({
          label: "Collector B",
          swarmGroupId: `swarm:${parentKey}:parent-turn`,
          subagentRunState: "active",
          hasActiveRun: true,
          status: "queued",
        });
        expect.soft([published?.startedAt, published?.runtimeMs]).toEqual([undefined, null]);

        const stopResponse = await abortCollector(
          { key: second.childSessionKey, agentId: "main", clearQueued: true },
          context,
        );
        expectAborted(stopResponse, second.runId);
        releaseSwarmRun(first.runId!);
        const stopped = (await listChildren(context)).sessions.find(
          (row) => row.key === second.childSessionKey,
        );
        expect(stopped).toMatchObject({
          label: "Collector B",
          status: "killed",
          hasActiveRun: false,
        });
        expect([stopped?.startedAt, stopped?.runtimeMs]).toEqual([undefined, undefined]);
        await expectUnstartedChildHistory(context, queued.key, []);
        expect(context.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            sessionKey: queued.key,
            reason: "abort",
            status: "killed",
            hasActiveRun: false,
            activeRunIds: [],
          }),
          new Set(["observer"]),
          expect.any(Object),
        );
        expect(launchedRunIds).toEqual([first.runId]);
      } finally {
        const hold = holdQueuedSwarmRun(second.runId!);
        if (hold) {
          hold.withdraw();
          void hold.release();
        }
        releaseSwarmRun(first.runId!);
      }
    } finally {
      unsubscribe();
      await Promise.all(publications);
    }
  });

  it("preserves an operator rename when a queued collector reaches agent dispatch", async () => {
    const context = requestContext();
    const secondRead = createDeferred();
    const readTarget = sessionStoreWorker.resolveGatewaySessionStoreTargetInWorker;
    let reads = 0;
    const readGate = vi
      .spyOn(sessionStoreWorker, "resolveGatewaySessionStoreTargetInWorker")
      .mockImplementation(async (...args) => {
        const order = ++reads;
        const target = await readTarget(...args);
        // Concurrent requester reads need not finish in invocation order.
        if (order === 1 && reads > 1) {
          await secondRead.promise;
        }
        if (order === 2) {
          secondRead.resolve();
        }
        return target;
      });
    const [first, second] = await spawnCollectors().finally(() => {
      secondRead.resolve();
      readGate.mockRestore();
    });
    const queued = expectDefined(
      (await listChildren(context)).sessions.find((row) => row.key === second!.childSessionKey),
      "queued row",
    );
    const options = requestOptions(context, "sessions.patch", {
      key: queued.key,
      expectedSessionId: queued.sessionId,
      label: "Operator renamed collector",
    });
    options.client = null;
    await sessionMutationHandlers["sessions.patch"]!(options);
    const { respond } = options;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entry: expect.objectContaining({ label: "Operator renamed collector" }),
      }),
      undefined,
    );
    releaseSwarmRun(first!.runId!);
    await waitForLaunch(second!.runId!);
    expect(launchedRunIds).toEqual([first!.runId, second!.runId]);
    const running = (await listChildren(context)).sessions.find((row) => row.key === queued.key);
    expect(running).toMatchObject({
      label: "Operator renamed collector",
      status: "running",
      hasActiveRun: true,
    });
  });

  it("keeps native spawn's normalized duplicate-label contract", async () => {
    const label = `  ${"Shared collector title ".repeat(4)}  `;
    const { gate, spy } = gateRequesterRead();
    const first = spawnCollector(label);
    try {
      // Finish the second preparation while the first still owns FIFO admission.
      const second = await spawnCollector(label);
      gate.resolve();
      const results = [await first, second];
      expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
      await Promise.race(
        results.map((result) => waitForLaunch(expectDefined(result.runId, "collector run"))),
      );
      expect(launchedRunIds).toEqual([results[0]!.runId]);
      expect((await listChildren(requestContext())).sessions.map((row) => row.label)).toEqual([
        label.trim(),
        label.trim(),
      ]);
      releaseSwarmRun(results[0]!.runId!);
      await waitForLaunch(expectDefined(second.runId, "second collector run"));
      expect(launchedRunIds).toEqual(results.map((result) => result.runId));
    } finally {
      gate.resolve();
      await first;
      spy.mockRestore();
    }
  });

  it("withdraws FIFO admission after requester acquisition is cancelled", async () => {
    const { gate, spy } = gateRequesterRead(true);
    const abort = new AbortController();
    const effectsStarted = vi.fn();
    const spawn = (label: string, assertActive?: () => void) =>
      spawnCollector(label, { onSpawnEffectsStart: effectsStarted, assertActive });
    const first = spawn("Failed requester", () => abort.signal.throwIfAborted());
    try {
      const second = await spawn("Surviving collector");
      expect(second.status).toBe("accepted");
      expect(launchedRunIds).toEqual([]);
      expect(effectsStarted).toHaveBeenCalledTimes(1);
      abort.abort(new Error("requester read cancelled"));
      gate.resolve();
      expect(await first).toEqual({
        status: "error",
        error: "sessions_spawn could not read the requester session: requester read cancelled",
      });
      expect(effectsStarted).toHaveBeenCalledTimes(2);
      await waitForLaunch(expectDefined(second.runId, "surviving collector run"));
      expect(launchedRunIds).toEqual([second.runId]);
    } finally {
      gate.resolve();
      await first;
      spy.mockRestore();
    }
  });

  it("keeps preactivation and held cancellation reservations pending until withdrawal", async () => {
    const { entry } = await createQueuedReservation();
    const context = requestContext();
    const expectPreparing = async () => {
      expect(isSubagentRunQueued(entry)).toBe(true);
      expect(
        resolveVisibleActiveSessionRunState({
          context,
          requestedKey: entry.childSessionKey,
          canonicalKey: entry.childSessionKey,
        }),
      ).toEqual({ active: true, runIds: [entry.runId] });
      expect((await listChildren(context)).sessions).toEqual([
        expect.objectContaining({
          status: "running",
          hasActiveRun: true,
          activeRunIds: [entry.runId],
        }),
      ]);
    };
    await expectPreparing();
    expect(
      resolveVisibleActiveSessionRunState({
        context,
        requestedKey: entry.childSessionKey,
        canonicalKey: entry.childSessionKey,
        agentId: "other",
      }),
    ).toEqual({ active: false, runIds: [] });
    const hold = expectDefined(holdQueuedSwarmRun(entry.runId), "queued hold");
    const start = vi.fn(async () => {});
    try {
      activateSwarmRun({
        groupId: entry.groupId!,
        runId: entry.runId,
        start,
        onStartFailure: () => true,
      });
      const session = expectDefined(
        (await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey)).entry,
        "created session",
      );
      const claim = expectDefined(
        await claimSubagentRunKill({
          runId: entry.runId,
          expected: entry,
          sessionId: session.sessionId,
          sessionLifecycleRevision: session.lifecycleRevision,
        }),
        "kill claim",
      );
      await expectPreparing();
      expect(start).not.toHaveBeenCalled();
      await releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim });
      expect(hold.withdraw()).toBe(true);
      expect(isSubagentRunQueued(entry)).toBe(false);
      expect((await listChildren(context)).sessions[0]?.hasActiveRun).toBe(false);
    } finally {
      await hold.release();
    }
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects stale copies, replaced owners, and lost reservations without losing compact status", async () => {
    const { entry, registration } = await createQueuedReservation();
    await replaceSessionEntry(
      {
        sessionKey: parentKey,
        storePath: (await loadGatewaySessionEntryReadOnlyAsync(parentKey)).storePath,
      },
      { sessionId: "parent-session", updatedAt: Date.now() },
    );
    const afterStaleGrace = Date.now() + 3 * 60 * 60_000;
    const projection = expectDefined(getSessionRowProjection(requestContext()), "queued row owner");
    const read = async (key: string) => {
      await projection.ensureMaterialized();
      return projection.snapshot({ key, agentId: "main" }, { now: afterStaleGrace }).row;
    };
    const exactChild = () => read(entry.childSessionKey);
    const exactParent = () => read(parentKey);
    expect(await exactChild()).toMatchObject({ status: "queued", hasActiveSubagentRun: true });
    expect((await exactParent())?.hasActiveSubagentRun).toBe(true);
    const compact = expectDefined(
      loadSubagentSessionListRunsFromSqlite(undefined, openOpenClawStateDatabase()).get(
        entry.runId,
      ),
      "compact queued record",
    );
    expect(compact.execution).toEqual({ status: "queued" });
    expect(compact.sessionStartedAt).toBeUndefined();
    expect(isSubagentRunQueued(compact)).toBe(false);
    expect(isSubagentRunQueued(structuredClone(entry))).toBe(false);

    await registerSubagentRun(registration);
    const replacement = expectDefined(subagentRuns.get(entry.runId), "replacement record");
    expect(replacement).not.toBe(entry);
    expect(isSubagentRunQueued(entry)).toBe(false);
    expect(isSubagentRunQueued(replacement)).toBe(false);
    expect((await exactChild())?.hasActiveSubagentRun).toBe(false);
    expect((await exactParent())?.hasActiveSubagentRun).not.toBe(true);
    expect((await listChildren(requestContext())).sessions[0]?.hasActiveRun).toBe(false);

    const hold = holdQueuedSwarmRun(entry.runId);
    try {
      hold?.withdraw();
      reserveAgain(entry);
      await registerSubagentRun(registration);
      const current = expectDefined(subagentRuns.get(entry.runId), "new reservation owner");
      expect(isSubagentRunQueued(current)).toBe(true);
      expect((await exactChild())?.hasActiveSubagentRun).toBe(true);
      expect((await exactParent())?.hasActiveSubagentRun).toBe(true);
      schedulerTesting.reset();
      expect(isSubagentRunQueued(current)).toBe(false);
      expect((await exactChild())?.hasActiveSubagentRun).toBe(false);
      expect((await exactParent())?.hasActiveSubagentRun).not.toBe(true);
      expect((await listChildren(requestContext())).sessions[0]?.hasActiveRun).toBe(false);
    } finally {
      await hold?.release();
    }
  });

  it("allows an administrator to stop the exact queued child", async () => {
    const { entry } = await createQueuedReservation();
    const unrelated = await createQueuedReservation("unrelated");
    const respond = await abortCollector(
      { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
      requestContext(),
      operatorClient("administrator", true),
    );
    expectAborted(respond, entry.runId);
    expect(subagentRuns.get(entry.runId)?.collectorCompletion?.status).toBe("killed");
    expect(subagentRuns.get(entry.runId)?.execution.startedAt).toBeUndefined();
    expect(isSubagentRunQueued(unrelated.entry)).toBe(true);
    expect(launchedRunIds).toEqual([]);
  });

  it("publishes queued Stop before its kill result allows replacement", async () => {
    const { entry, registration } = await createQueuedReservation();
    const context = requestContext();
    const order: string[] = [];
    vi.mocked(context.broadcastToConnIds).mockImplementation(() => {
      expect(isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry)).toBe(true);
      expect(subagentRuns.get(entry.runId)?.collectorCompletion?.status).toBe("killed");
      order.push("published");
    });
    const kill = subagentKill.killSubagentRunAdmin;
    using _ = vi.spyOn(subagentKill, "killSubagentRunAdmin").mockImplementation(async (...args) => {
      const result = await kill(...args);
      // Real cancellation is complete; an awaited consumer can now observe
      // another owner before it consumes the predecessor's result.
      await releaseSubagentRun(entry.runId);
      reserveAgain(entry);
      await registerSubagentRun(registration);
      order.push("replacement");
      return result;
    });
    const respond = await abortCollector({ key: entry.childSessionKey }, context);
    expect(order).toEqual(["published", "replacement"]);
    expectAborted(respond, entry.runId);
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ status: "killed", hasActiveRun: false, activeRunIds: [] }),
      new Set(["observer"]),
      expect.any(Object),
    );
    const successor = subagentRuns.get(entry.runId);
    expect(successor).not.toBe(entry);
    expect(isSubagentRunQueued(successor)).toBe(true);
    expect(successor?.execution.endedAt).toBeUndefined();
  });

  it.each([
    ["foreign requester", false],
    ["parent replaced", false],
    ["parent closed", false],
    ["parent settled", false],
    ["parent lifecycle retired", false],
    ["session access revoked", false],
    ["reservation withdrawn", false],
    ["registry replaced", false],
    ["session access revoked", true],
  ] as const)("rejects queued-child Stop when %s (typed=%s)", async (failure, typed) => {
    const { entry, registration } = await createQueuedReservation();
    const unrelated = await createQueuedReservation("unrelated");
    const context = requestContext();
    const parent = expectDefined(
      context.chatAbortControllers.get("parent-turn"),
      "parent admission",
    );
    let authorizationObserved = false;
    let accessRevoked = false;
    const authorization = createDeferred();
    // Preserve the post-authorization microtask race, but join queued registration's durable setup.
    const mutation = authorization.promise.then(async () => {
      if (!authorizationObserved) {
        return;
      }
      if (failure === "parent replaced") {
        context.chatAbortControllers.set("parent-turn", { ...parent });
      }
      if (failure === "parent closed") {
        parent.controller.abort();
      }
      if (failure === "parent settled") {
        parent.isAbortable = () => false;
      }
      if (failure === "parent lifecycle retired") {
        parent.lifecycleGeneration = "retired";
      }
      if (failure === "session access revoked") {
        accessRevoked = true;
      }
      if (failure === "reservation withdrawn") {
        const hold = holdQueuedSwarmRun(entry.runId);
        try {
          hold?.withdraw();
        } finally {
          await hold?.release();
        }
      }
      if (failure === "registry replaced") {
        await registerSubagentRun(registration);
      }
    });
    const assertCurrent = () => {
      if (!authorizationObserved) {
        authorizationObserved = true;
        authorization.resolve();
      }
      if (accessRevoked) {
        throw new Error("Session mutation authorization changed");
      }
    };
    const options = requestOptions(
      context,
      typed ? "chat.send" : "sessions.abort",
      typed
        ? { sessionKey: entry.childSessionKey, message: "/stop", idempotencyKey: "typed-stop" }
        : { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
    );
    options.client = operatorClient(
      failure === "foreign requester" ? "other-requester" : "parent-requester",
    );
    const authorizedOptions = {
      ...options,
      sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent },
    };
    const { respond } = options;
    const abort = typed
      ? handleChatSend(authorizedOptions)
      : sessionAbortHandlers["sessions.abort"]!(authorizedOptions);
    await Promise.all([Promise.resolve(abort).finally(() => authorization.resolve()), mutation]);
    expectRejected(respond);
    expect(entry.execution.endedAt).toBeUndefined();
    expect(entry.collectorCompletion).toBeUndefined();
    if (typed) {
      expect(isSubagentRunQueued(entry)).toBe(true);
    }
    expect(isSubagentRunQueued(unrelated.entry)).toBe(true);
    expect(launchedRunIds).toEqual([]);
  });

  it("keeps the controlling parent authoritative when native completion routing differs", async () => {
    const completionOwner = "agent:main:dashboard:completion-recipient";
    replaceSessionEntrySync(
      { sessionKey: completionOwner, agentId: "main" },
      { sessionId: "original-completion-owner", updatedAt: Date.now() },
    );
    const context = requestContext();
    const spawn = nativeSpawn.spawnSubagentDirect;
    const spawning = vi
      .spyOn(nativeSpawn, "spawnSubagentDirect")
      .mockImplementation((params, ctx) =>
        spawn(params, {
          ...ctx,
          onSpawnEffectsStart: () =>
            replaceSessionEntrySync(
              { sessionKey: completionOwner, agentId: "main" },
              { sessionId: "replacement-completion-owner", updatedAt: Date.now() },
            ),
        }),
      );
    const [first, second] = await spawnCollectors(undefined, completionOwner).finally(() =>
      spawning.mockRestore(),
    );
    expect(subagentRuns.get(first!.runId!)?.completionRequesterSessionId).toBe(
      "original-completion-owner",
    );
    const entry = expectDefined(subagentRuns.get(second!.runId!), "proxied queued collector");
    expect(entry).toMatchObject({
      controllerSessionKey: parentKey,
      requesterSessionKey: completionOwner,
      swarmRequesterSessionKey: parentKey,
    });
    const respond = await abortCollector(
      { key: entry.childSessionKey, runId: entry.runId },
      context,
    );
    expectAborted(respond, entry.runId);
    expect(subagentRuns.get(entry.runId)?.collectorCompletion?.status).toBe("killed");
  });

  it.each([
    { method: "sessions.abort", exact: false, scenario: "owned" },
    { method: "sessions.abort", exact: false, scenario: "foreign" },
    { method: "sessions.abort", exact: false, scenario: "parent-retired" },
    { method: "sessions.abort", exact: false, scenario: "mixed" },
    { method: "sessions.abort", exact: true, scenario: "owned" },
    { method: "chat.send", exact: false, scenario: "owned" },
    { method: "chat.send", exact: false, scenario: "foreign" },
  ])(
    "coordinates queued Stop with a real coexisting chat admission: $method exact=$exact $scenario",
    async ({ method, exact, scenario }) => {
      const foreign = scenario === "foreign";
      const { entry } = await createQueuedReservation();
      const context = requestContext();
      const extraRunId = "additional-admitted-chat";
      const admitOrdinaryChat = async (runId: string, ownerConnId: string) => {
        const prepared = expectDefined(
          await prepareAndAdmitChatSend({
            params: {
              sessionKey: entry.childSessionKey,
              message: "Additional child input",
              idempotencyKey: runId,
            },
            context,
            respond: vi.fn(),
            client: operatorClient(ownerConnId),
          }),
          "ordinary chat admission while collector is queued",
        );
        return prepared.admission;
      };
      const admission = await admitOrdinaryChat(
        extraRunId,
        foreign ? "other-requester" : "parent-requester",
      );
      const foreignRunId = "foreign-admitted-chat";
      const foreignAdmission =
        scenario === "mixed" ? await admitOrdinaryChat(foreignRunId, "other-requester") : undefined;
      admission.activeRunAbort.markExecutionStarted();
      context.chatRunState.getOrCreate(extraRunId).buffer = "Additional run partial";
      const cleanup = () => {
        admission.cleanupAdmittedRun();
        clearAgentRunContext(extraRunId);
      };
      admission.activeRunAbort.controller.signal.addEventListener(
        "abort",
        () =>
          queueMicrotask(() => {
            if (scenario === "parent-retired") {
              context.chatAbortControllers.delete("parent-turn");
            }
            cleanup();
          }),
        { once: true },
      );
      expect(context.chatAbortControllers.get(extraRunId)).toBe(admission.activeRunAbort.entry);
      expect(isSubagentRunQueued(entry)).toBe(true);
      try {
        const options = requestOptions(
          context,
          method,
          method === "sessions.abort"
            ? {
                key: entry.childSessionKey,
                ...(exact ? { runId: entry.runId } : { clearQueued: true }),
              }
            : {
                sessionKey: entry.childSessionKey,
                message: "/stop",
                idempotencyKey: "typed-stop",
              },
        );
        const { respond } = options;
        if (method === "sessions.abort") {
          await sessionAbortHandlers["sessions.abort"]!(options);
        } else {
          await handleChatSend(options);
        }
        const stopped = !foreign && !exact;
        const collectorStopped = stopped && scenario === "owned";
        expect.soft(respond.mock.calls[0]?.[0]).toBe(collectorStopped);
        if (foreignAdmission) {
          expect(foreignAdmission.activeRunAbort.controller.signal.aborted).toBe(false);
          expect(context.chatAbortControllers.get(foreignRunId)).toBe(
            foreignAdmission.activeRunAbort.entry,
          );
          expectRejected(respond, { code: "UNAVAILABLE" }, true);
        }
        expect.soft(admission.activeRunAbort.controller.signal.aborted).toBe(stopped);
        expect.soft(isSubagentRunQueued(entry)).toBe(!collectorStopped);
        expect.soft(context.chatRunState.hasAbortMarker(extraRunId)).toBe(stopped);
        if (scenario === "parent-retired") {
          expectRejected(respond, {
            message: expect.stringContaining("Unauthorized queued collector Stop"),
          });
        }
        expect
          .soft(admission.activeRunAbort.entry?.abortStopReason)
          .toBe(stopped ? (method === "chat.send" ? "stop" : "rpc") : undefined);
        const session = await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey);
        const events = await loadTranscriptEvents({
          agentId: "main",
          storePath: session.storePath,
          sessionKey: entry.childSessionKey,
          sessionId: session.entry!.sessionId,
        });
        if (stopped) {
          expect(events).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({
                content: [{ type: "text", text: "Additional run partial" }],
                openclawAbort: expect.objectContaining({ runId: extraRunId, aborted: true }),
              }),
            }),
          );
        } else {
          expect(events).toEqual([]);
        }
        expect(launchedRunIds).toEqual([]);
      } finally {
        cleanup();
        if (foreignAdmission) {
          foreignAdmission.cleanupAdmittedRun();
          clearAgentRunContext(foreignRunId);
        }
      }
    },
  );

  it("keeps ordinary chat.abort and mismatched exact Stop from consuming a collector", async () => {
    const { entry } = await createQueuedReservation();
    const context = requestContext();
    const options = requestOptions(context, "chat.abort", {
      sessionKey: entry.childSessionKey,
      runId: "reserved-collector",
    });
    await handleChatAbortRequest(options);
    expect(options.respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
    const sessionResponse = await abortCollector(
      { key: entry.childSessionKey, runId: "other-run", agentId: "main" },
      context,
    );
    expect(sessionResponse).toHaveBeenCalledWith(
      true,
      { ok: true, status: "no-active-run", abortedRunId: null },
      undefined,
      undefined,
    );
    expect(isSubagentRunQueued(entry)).toBe(true);
  });
});
