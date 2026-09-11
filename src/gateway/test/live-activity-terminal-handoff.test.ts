import http2 from "node:http2";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as config from "../../config/io.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  emitAgentEventForOwner,
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload,
} from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { verifyDeviceToken } from "../../infra/device-pairing-tokens.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import * as apns from "../../infra/push-apns.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { installInMemoryTaskRegistryRuntime } from "../../test-utils/task-registry-runtime.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import {
  ACTIVITY_EPOCH,
  activityAuth,
  activityDirect,
  activityRelay,
  readActivityRequestBody,
  withLiveActivityFixture,
} from "../live-activity.test-support.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import { disconnectStaleSharedGatewayAuthClients } from "../server-shared-auth-generation.js";
import { createSessionLifecyclePersistenceOwner } from "../session-lifecycle-persistence-owner.js";
import * as lifecycleState from "../session-lifecycle-state.js";

// Isolate unrelated background audit work; lifecycle, SQLite, and delivery owners stay real.
vi.mock("../../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({
    record: vi.fn(),
    recordTool: vi.fn(),
    recordMessage: vi.fn(),
    recordExecutionIdentity: vi.fn(() => true),
    recordExecutionDecision: vi.fn(() => true),
    stop: vi.fn(async () => {}),
  }),
}));

type ActivityFixture = Parameters<Parameters<typeof withLiveActivityFixture>[0]>[0];

function startSubscriptions(f: ActivityFixture, onCommitted = f.coordinator.observe) {
  f.stopObserving();
  vi.spyOn(config, "getRuntimeConfig").mockReturnValue(f.cfg);
  installInMemoryTaskRegistryRuntime();
  const log: SubsystemLogger = {
    subsystem: "gateway-activity-test",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: f.log.warn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => log,
  };
  const chatRunState = createChatRunState();
  const ops = {
    sessionLifecyclePersistence: createSessionLifecyclePersistenceOwner({
      onCommitted,
      onTerminalTransition: f.coordinator.holdTerminal,
    }),
    chatAbortControllers: f.chatAbortControllers,
    chatRunState,
    removeChatRun: chatRunState.registry.remove,
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
  const subscriptions = startGatewayEventSubscriptions({
    ...ops,
    log,
    broadcastToConnIds: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    restartRecoveryCandidates: new Map(),
    terminalSessions: { closeTaskSessions: vi.fn() },
    refreshConnectedUserProfiles: vi.fn(),
    liveActivityCoordinator: f.coordinator,
  });
  return {
    ops,
    stop: async () => {
      subscriptions.heartbeatUnsub();
      subscriptions.transcriptUnsub();
      subscriptions.lifecycleUnsub();
      await subscriptions.agentUnsub();
      await subscriptions.taskUnsub();
      chatRunState.clear();
      resetTaskRegistryForTests({ persist: false });
    },
  };
}

function holdSessionWrites(f: ActivityFixture) {
  const entered = createDeferred();
  const release = createDeferred();
  const pending = patchSessionEntryCore(
    f.session,
    async () => {
      entered.resolve();
      await release.promise;
      return null;
    },
    { skipMaintenance: true },
  );
  return { entered: entered.promise, release: release.resolve, pending };
}

function expectTerminalDelivery(
  status: "completed" | "cancelled",
  observedAtMs: number,
  requestIndex = 1,
) {
  expect(fetch).toHaveBeenCalledTimes(requestIndex + 1);
  const body = JSON.parse(readActivityRequestBody(vi.mocked(fetch).mock.calls[requestIndex]?.[1]));
  expect(body).toMatchObject({
    relayHandle: "activity-handle",
    purpose: "liveActivity",
    priority: 10,
    payload: {
      aps: {
        event: "end",
        "stale-date": Math.floor(observedAtMs / 1_000) + 240,
        "content-state": {
          status,
          observedAt: observedAtMs / 1_000 - 978307200,
          startedAt: ACTIVITY_EPOCH / 1_000 - 978307200,
          endedAt: observedAtMs / 1_000 - 978307200,
        },
      },
    },
  });
}

function readStoredDestination(registrationId: string) {
  const { db } = openOpenClawStateDatabase();
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("apns_live_activities")
      .select("destination_json")
      .where("registration_id", "=", registrationId),
  )?.destination_json;
}

it.each([false, true])(
  "settles an already queued progress 410 with terminal handoff=%s",
  async (terminalHandoff) => {
    await withLiveActivityFixture(
      async (f) => {
        await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
        const registered = await f.register();
        await vi.advanceTimersByTimeAsync(0);
        const originalDestination = readStoredDestination(registered.registrationId);
        expect(originalDestination).toEqual(expect.any(String));
        const runtime = startSubscriptions(f);
        const gate = holdSessionWrites(f);
        const response = createDeferred<Response>();
        try {
          await gate.entered;
          vi.mocked(fetch).mockImplementationOnce(() => response.promise);
          emitAgentEventForOwner(
            { runId: f.internalRunId, stream: "tool", data: { phase: "start" } },
            f.claimId,
          );
          await vi.advanceTimersByTimeAsync(5_000);
          expect(fetch).toHaveBeenCalledTimes(2);
          const progressRequest = vi.mocked(fetch).mock.calls[1]!;
          expect(JSON.parse(readActivityRequestBody(progressRequest[1]))).toMatchObject({
            purpose: "liveActivity",
            payload: { aps: { event: "update", "content-state": { status: "toolRunning" } } },
          });
          expect(progressRequest[1]?.signal?.aborted).toBe(false);
          const observedAtMs = Date.now();

          // Queue the response before terminal ingress, without yielding. Aborting
          // the transport cannot remove a result already queued for settlement.
          response.resolve(
            new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 }),
          );
          if (terminalHandoff) {
            emitAgentEventForOwner(
              {
                runId: f.internalRunId,
                stream: "lifecycle",
                data: { phase: "end", endedAt: observedAtMs },
              },
              f.claimId,
            );
          }
          const terminal = f.entry.projectSessionTerminalPersistence;
          if (terminalHandoff) {
            expect(terminal).toBeDefined();
            expect(f.entry.projectSessionTerminalPending).toBe(true);
          }
          await vi.advanceTimersByTimeAsync(5_000);
          expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("running");
          expect(fetch).toHaveBeenCalledTimes(2);

          if (!terminalHandoff) {
            expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("tombstone");
            expect(readStoredDestination(registered.registrationId)).toBeNull();
            return;
          }
          expect(readStoredDestination(registered.registrationId)).toBe(originalDestination);
          expect(f.coordinator.store.load(registered.registrationId)).toMatchObject({
            state: "active",
            leaseExpiresAtMs: registered.leaseExpiresAtMs,
          });
          gate.release();
          await gate.pending;
          await terminal;
          expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("done");
          await vi.advanceTimersByTimeAsync(1_000);
          expectTerminalDelivery("completed", observedAtMs, 2);
          const terminalRequest = vi.mocked(fetch).mock.calls[2]!;
          expect(terminalRequest[0]).toBe(progressRequest[0]);
          expect(new Headers(terminalRequest[1]?.headers).get("authorization")).toBe(
            new Headers(progressRequest[1]?.headers).get("authorization"),
          );
          expect(JSON.parse(readActivityRequestBody(terminalRequest[1])).relayHandle).toBe(
            JSON.parse(readActivityRequestBody(progressRequest[1])).relayHandle,
          );
        } finally {
          response.resolve(new Response(null, { status: 410 }));
          gate.release();
          await gate.pending;
          await runtime.stop();
        }
      },
      { internalRunId: "public-activity-run" },
    );
  },
);

it("delivers the committed terminal when due progress races a held terminal write", async () => {
  await withLiveActivityFixture(
    async (f) => {
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      await f.register();
      await vi.advanceTimersByTimeAsync(0);
      const runtime = startSubscriptions(f);
      const gate = holdSessionWrites(f);
      try {
        await gate.entered;
        emitAgentEventForOwner(
          {
            runId: f.internalRunId,
            stream: "tool",
            data: { phase: "start" },
          },
          f.claimId,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        const observedAtMs = Date.now();
        emitAgentEventForOwner(
          {
            runId: f.internalRunId,
            stream: "lifecycle",
            data: { phase: "end", endedAt: observedAtMs },
          },
          f.claimId,
        );
        const terminal = f.entry.projectSessionTerminalPersistence;
        expect(terminal).toBeDefined();
        expect(f.entry.projectSessionTerminalPending).toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("running");
        expect(fetch).toHaveBeenCalledOnce();

        gate.release();
        await gate.pending;
        await terminal;
        expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("done");
        await vi.advanceTimersByTimeAsync(0);
        expectTerminalDelivery("completed", observedAtMs);
      } finally {
        gate.release();
        await gate.pending;
        await runtime.stop();
      }
    },
    { internalRunId: "public-activity-run" },
  );
});

it.each([false, true])(
  "delivers a registered distinct-ID public abort with later claimed terminal=%s",
  async (laterTerminal) => {
    await withLiveActivityFixture(
      async (f) => {
        await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
        await f.emit("tool", { phase: "start" });
        await f.emit("tool", { phase: "result" });
        const sourceSequence = f.entry.liveActivityFact!.snapshot!.sequence;
        await f.register();
        await vi.advanceTimersByTimeAsync(1_000);
        const runtime = startSubscriptions(f);
        const gate = holdSessionWrites(f);
        const events: AgentEventRuntimePayload[] = [];
        const stopRecording = onAgentRuntimeEvent((event) => events.push(event));
        try {
          await gate.entered;
          expect(f.publicRunId).not.toBe(f.internalRunId);
          const observedAtMs = Date.now();
          expect(
            abortChatRunById(runtime.ops, {
              runId: f.publicRunId,
              sessionKey: f.session.sessionKey,
              stopReason: "rpc",
            }),
          ).toEqual({ aborted: true });
          const publicAbort = events.find((event) => event.runId === f.publicRunId);
          expect(publicAbort?.seq).toBeLessThan(sourceSequence);
          const terminal = f.entry.projectSessionTerminalPersistence;
          expect(terminal).toBeDefined();
          expect(f.entry.controller.signal.aborted).toBe(true);
          expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("running");
          expect(fetch).toHaveBeenCalledOnce();

          gate.release();
          await gate.pending;
          await terminal;
          expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("killed");
          if (laterTerminal) {
            emitAgentEventForOwner(
              {
                runId: f.internalRunId,
                stream: "lifecycle",
                data: {
                  phase: "end",
                  status: "cancelled",
                  aborted: true,
                  stopReason: "rpc",
                  startedAt: ACTIVITY_EPOCH,
                  endedAt: observedAtMs,
                },
              },
              f.claimId,
            );
            expect(
              events.some(
                (event) =>
                  event.runId === f.internalRunId &&
                  event.contextClaimId === f.claimId &&
                  event.data.phase === "end",
              ),
            ).toBe(true);
            await patchSessionEntryCore(f.session, () => null, { skipMaintenance: true });
          }
          await vi.advanceTimersByTimeAsync(0);
          expectTerminalDelivery("cancelled", observedAtMs);
        } finally {
          stopRecording();
          gate.release();
          await gate.pending;
          await runtime.stop();
        }
      },
      { publicRunId: "public-abort-sequence-run" },
    );
  },
);

it.each(["claimed predecessor", "synchronous public abort"] as const)(
  "preserves a successor installed before terminal ingress from %s",
  async (ingress) => {
    await withLiveActivityFixture(async (f) => {
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      const predecessor = await f.register();
      await vi.advanceTimersByTimeAsync(1_000);
      const successorRunId = "successor-activity-producer";
      const successor: ChatAbortControllerEntry = {
        ...f.entry,
        controller: new AbortController(),
        liveActivityRun: Object.freeze({
          publicRunId: f.publicRunId,
          internalRunId: successorRunId,
        }),
        liveActivityFact: undefined,
        projectSessionActive: true,
        projectSessionTerminalPending: false,
        projectSessionTerminalObservedAt: undefined,
        projectSessionTerminalPersistence: undefined,
        projectSessionTerminalPersisted: false,
      };
      const successorClaim = claimAgentRunContext(
        successorRunId,
        {
          ...f.session,
          sessionId: successor.sessionId,
          lifecycleGeneration: successor.lifecycleGeneration,
        },
        { exclusive: true, trackOwner: true },
      );
      if (!successorClaim) {
        throw new Error("Fixture requires a distinct successor claim");
      }
      const started = createDeferred();
      const runtime = startSubscriptions(f, (fact) => {
        f.coordinator.observe(fact);
        if (fact.source.entry === successor && fact.snapshot.status === "running") {
          started.resolve();
        }
      });
      let successorFact: ChatAbortControllerEntry["liveActivityFact"];
      const installSuccessor = () => {
        f.chatAbortControllers.set(f.publicRunId, successor);
        emitAgentEventForOwner(
          {
            runId: successorRunId,
            stream: "lifecycle",
            data: { phase: "start", startedAt: Date.now() },
          },
          successorClaim,
        );
        successorFact = successor.liveActivityFact;
      };
      const destination = { ...activityRelay, relayHandle: "successor-activity-handle" };
      let registered: Awaited<ReturnType<typeof f.register>> | undefined;
      try {
        if (ingress === "claimed predecessor") {
          installSuccessor();
          await started.promise;
          registered = await f.register(destination, undefined, "successor-activity");
          await vi.advanceTimersByTimeAsync(0);
          emitAgentEventForOwner(
            { runId: successorRunId, stream: "tool", data: { phase: "start" } },
            successorClaim,
          );
          successorFact = successor.liveActivityFact;
          expect(f.coordinator.store.load(predecessor.registrationId)?.state).toBe("active");
          emitAgentEventForOwner(
            {
              runId: f.internalRunId,
              stream: "lifecycle",
              data: { phase: "end", endedAt: Date.now() },
            },
            f.claimId,
          );
        } else {
          // The abort owner captures the predecessor before synchronous listeners
          // install its successor, then emits the predecessor's public terminal.
          f.entry.controller.signal.addEventListener("abort", installSuccessor, { once: true });
          expect(
            abortChatRunById(runtime.ops, {
              runId: f.publicRunId,
              sessionKey: f.session.sessionKey,
              stopReason: "rpc",
            }),
          ).toEqual({ aborted: true });
        }
        expect.soft(f.chatAbortControllers.get(f.publicRunId)).toBe(successor);
        expect.soft(successor).toMatchObject({
          projectSessionActive: true,
          projectSessionTerminalPending: false,
          projectSessionTerminalObservedAt: undefined,
          projectSessionTerminalPersistence: undefined,
          projectSessionTerminalPersisted: false,
        });
        expect.soft(successor.liveActivityFact).toBe(successorFact);
        expect.soft(successor.controller.signal.aborted).toBe(false);
        await started.promise;
        await patchSessionEntryCore(f.session, () => null, { skipMaintenance: true });
        if (!registered) {
          registered = await f.register(destination, undefined, "successor-activity");
          await vi.advanceTimersByTimeAsync(0);
          emitAgentEventForOwner(
            { runId: successorRunId, stream: "tool", data: { phase: "start" } },
            successorClaim,
          );
        }
        await vi.advanceTimersByTimeAsync(5_000);
        expect.soft(loadExactSessionEntryReadOnly(f.session)?.entry).toMatchObject({
          status: "running",
          lifecycleRunId: successorRunId,
        });
        expect.soft(f.coordinator.store.load(registered.registrationId)).toMatchObject({
          state: "active",
          sourceIncarnation: registered.sourceIncarnation,
          snapshot: { status: "toolRunning" },
        });
        expect.soft(readStoredDestination(registered.registrationId)).toEqual(expect.any(String));
        const deliveries = vi
          .mocked(fetch)
          .mock.calls.map(([, init]) => JSON.parse(readActivityRequestBody(init)))
          .filter((body) => body.relayHandle === destination.relayHandle);
        expect(deliveries.map((body) => body.payload.aps.event)).toEqual(["update", "update"]);
        expect(deliveries[1]?.payload.aps["content-state"].status).toBe("toolRunning");
      } finally {
        f.entry.controller.signal.removeEventListener("abort", installSuccessor);
        await runtime.stop();
        releaseAgentRunContext(successorRunId, successorClaim);
      }
    });
  },
);

it.each(["pairing", "profile", "claim", "registration", "lease"] as const)(
  "does not preserve delivery authority after %s loss during a held terminal write",
  async (loss) => {
    await withLiveActivityFixture(async (f) => {
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      const registered = await f.register();
      await vi.advanceTimersByTimeAsync(0);
      const runtime = startSubscriptions(f);
      const gate = holdSessionWrites(f);
      try {
        await gate.entered;
        emitAgentEventForOwner(
          { runId: f.internalRunId, stream: "tool", data: { phase: "start" } },
          f.claimId,
        );
        emitAgentEventForOwner(
          {
            runId: f.internalRunId,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now() },
          },
          f.claimId,
        );
        const terminal = f.entry.projectSessionTerminalPersistence;
        expect(terminal).toBeDefined();
        const settled = terminal!.catch(() => undefined);
        if (loss === "pairing") {
          f.device.nodeSurface!.approvedAtMs += 1;
          f.pair();
        } else if (loss === "profile") {
          setUserProfileRole(f.profile.id, "reader");
        } else if (loss === "claim") {
          releaseAgentRunContext(f.internalRunId, f.claimId);
        } else if (loss === "registration") {
          f.chatAbortControllers.set(f.publicRunId, {
            ...f.entry,
            controller: new AbortController(),
            liveActivityFact: undefined,
            projectSessionActive: true,
            projectSessionTerminalPending: false,
            projectSessionTerminalPersistence: undefined,
          });
        }
        await vi.advanceTimersByTimeAsync(loss === "lease" ? 8 * 3_600_000 : 5_000);
        expect(fetch).toHaveBeenCalledOnce();
        expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("tombstone");
        expect(readStoredDestination(registered.registrationId)).toBeNull();
        gate.release();
        await gate.pending;
        await settled;
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledOnce();
        if (loss === "registration") {
          expect(f.chatAbortControllers.get(f.publicRunId)).toMatchObject({
            projectSessionActive: true,
            projectSessionTerminalPending: false,
            projectSessionTerminalPersistence: undefined,
          });
        }
      } finally {
        gate.release();
        await gate.pending;
        await runtime.stop();
      }
    });
  },
);

it.each(["no-op", "failure"] as const)(
  "releases a %s terminal write without inventing a terminal fact or retaining its hold",
  async (outcome) => {
    await withLiveActivityFixture(async (f) => {
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      const registered = await f.register();
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === "no-op") {
        await upsertSessionEntryCore(f.session, {
          sessionId: f.entry.sessionId,
          lifecycleRevision: f.entry.preparedSession!.lifecycleRevision ?? undefined,
          updatedAt: Date.now(),
          startedAt: Date.now(),
          status: "running",
          lifecycleRunId: "successor",
        });
      }
      const runtime = startSubscriptions(f);
      const gate = holdSessionWrites(f);
      const failure = createDeferred();
      try {
        await gate.entered;
        if (outcome === "failure") {
          vi.spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent").mockImplementationOnce(
            () => failure.promise,
          );
        }
        emitAgentEventForOwner(
          { runId: f.internalRunId, stream: "tool", data: { phase: "start" } },
          f.claimId,
        );
        emitAgentEventForOwner(
          {
            runId: f.internalRunId,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now() },
          },
          f.claimId,
        );
        const terminal = f.entry.projectSessionTerminalPersistence;
        expect(terminal).toBeDefined();
        const settled = terminal!.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fetch).toHaveBeenCalledOnce();
        expect(f.coordinator.store.load(registered.registrationId)).toMatchObject({
          state: "active",
        });
        expect(readStoredDestination(registered.registrationId)).toEqual(expect.any(String));
        gate.release();
        await gate.pending;
        if (outcome === "failure") {
          failure.reject(new Error("terminal persistence unavailable"));
        }
        await settled;
        await vi.advanceTimersByTimeAsync(0);
        expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("tombstone");
        expect(readStoredDestination(registered.registrationId)).toBeNull();
        expect(fetch).toHaveBeenCalledOnce();
        expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("running");
        expect(f.entry.projectSessionTerminalPersistence).toBeUndefined();
      } finally {
        failure.resolve();
        gate.release();
        await gate.pending;
        await runtime.stop();
      }
    });
  },
);

it("fences an unconsumed progress claim before awaited direct authorization returns", async () => {
  await withLiveActivityFixture(async (f) => {
    const auth = createDeferred<Awaited<ReturnType<typeof apns.resolveApnsAuthConfigFromEnv>>>();
    const entered = createDeferred();
    vi.spyOn(apns, "resolveApnsAuthConfigFromEnv")
      .mockResolvedValueOnce({ ok: true, value: activityAuth })
      .mockImplementationOnce(() => {
        entered.resolve();
        return auth.promise;
      });
    const connect = vi.spyOn(http2, "connect").mockImplementation(() => {
      throw new Error("Unexpected activity network dispatch");
    });
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register(activityDirect);
    await entered.promise;
    const runtime = startSubscriptions(f);
    const gate = holdSessionWrites(f);
    try {
      await gate.entered;
      emitAgentEventForOwner(
        {
          runId: f.internalRunId,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        },
        f.claimId,
      );
      expect(f.entry.projectSessionTerminalPersistence).toBeDefined();
      auth.resolve({ ok: true, value: activityAuth });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connect).not.toHaveBeenCalled();
      expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("active");
      expect(readStoredDestination(registered.registrationId)).toEqual(expect.any(String));
    } finally {
      f.coordinator.beginClose();
      auth.resolve({ ok: true, value: activityAuth });
      gate.release();
      await gate.pending;
      await runtime.stop();
    }
  });
});

it("retains the approved offline lease when shared-key rotation fences the original connection", async () => {
  await withLiveActivityFixture(async (f) => {
    const operator = f.device.tokens?.operator;
    if (!operator) {
      throw new Error("Fixture requires a paired operator token");
    }
    operator.issuer = { kind: "shared-gateway-auth", generation: "previous-generation" };
    f.pair();
    const client = Object.assign(f.client, {
      usesSharedGatewayAuth: true,
      sharedGatewaySessionGeneration: "previous-generation",
      socket: { close: vi.fn(() => f.disconnect()) },
    });
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(0);

    disconnectStaleSharedGatewayAuthClients({
      clients: [client],
      expectedGeneration: "current-generation",
    });
    expect(client).toMatchObject({ invalidated: true, invalidatedReason: "gateway-auth-changed" });
    expect(
      await verifyDeviceToken({
        deviceId: f.device.deviceId,
        token: operator.token,
        role: "operator",
        scopes: ["operator.admin"],
        requiredSharedGatewaySessionGeneration: "current-generation",
      }),
    ).toMatchObject({ ok: false, reason: "issuer-generation-stale" });
    await f.emit("tool", { phase: "start" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.coordinator.store.load(registered.registrationId)).toMatchObject({
      state: "active",
      leaseExpiresAtMs: registered.leaseExpiresAtMs,
      binding: registered.binding,
    });
    expect(JSON.parse(readActivityRequestBody(vi.mocked(fetch).mock.calls[1]?.[1]))).toMatchObject({
      payload: { aps: { event: "update", "content-state": { status: "toolRunning" } } },
    });
  });
});
