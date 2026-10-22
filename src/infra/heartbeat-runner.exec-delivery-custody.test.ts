import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import * as durableMessages from "../channels/message/send.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as exec from "./exec-request-context.js";
import { getLastHeartbeatEvent } from "./heartbeat-events.js";
import * as heartbeatOutcomes from "./heartbeat-outcome-store.js";
import { bindHeartbeatReply, bindHeartbeatSend } from "./heartbeat-runner.boundary-test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  heartbeatTestConfig,
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { PlatformMessageNotDispatchedError } from "./outbound/deliver-types.js";
import * as deliveryLease from "./outbound/delivery-queue-lease.js";
import { drainPendingDeliveriesCore } from "./outbound/delivery-queue-recovery.js";
import { enqueueDelivery, ackDelivery } from "./outbound/delivery-queue-storage.js";
import { loadPendingDeliveries } from "./outbound/delivery-queue.test-helpers.js";
import * as events from "./system-events.js";

const capturedRoute = {
  channel: "telegram",
  to: "telegram:-1003774691294:topic:47",
  accountId: "work",
  threadId: 47,
};
type Sandbox = Parameters<Parameters<typeof withTempHeartbeatSandbox>[0]>[0];
async function custodyFixture(
  { tmpDir, storePath, replySpy }: Sandbox,
  mode: "captured" | "personal" | "legacy" = "captured",
  sessionId?: string,
) {
  const personal = mode === "personal";
  const legacy = mode === "legacy";
  const cfg = heartbeatTestConfig(tmpDir, personal ? "telegram" : "last", "telegram", storePath);
  const destination =
    personal || legacy
      ? { to: legacy ? "telegram:123456789" : "123456789", accountId: "personal" }
      : capturedRoute;
  if (personal) {
    Object.assign(cfg.agents!.defaults!.heartbeat!, { target: "telegram", ...destination });
  }
  const sessionKey = await seedMainSessionStore(storePath, cfg, {
    ...(sessionId ? { sessionId } : {}),
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: destination.to,
    lastAccountId: destination.accountId,
    ...(personal || legacy ? {} : { lastThreadId: 47 }),
  });
  bindHeartbeatReply(replySpy);
  const run = (options: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "sessionKey"> = {}) =>
    runHeartbeatOnce({
      cfg,
      sessionKey,
      source: "exec-event",
      reason: "exec-event",
      ...options,
    });
  const enqueue = (name: string, text: string, route = capturedRoute) =>
    events.enqueueSystemEvent(`Exec completed (${name}, code 0) :: ${text}`, {
      sessionKey,
      contextKey: `exec:${name}`,
      deliveryContext: route,
    });
  const echoSelected = (first: string, second: string) =>
    replySpy.mockImplementation(async (ctx) => ({
      text: ctx.Body?.includes(first) ? first : second,
    }));
  return { cfg, sessionKey, route: capturedRoute, run, enqueue, replySpy, echoSelected };
}
function withCustody(
  scenario: (fixture: Awaited<ReturnType<typeof custodyFixture>>) => Promise<void>,
  mode?: Parameters<typeof custodyFixture>[1],
  sessionId?: string,
) {
  return withTempHeartbeatSandbox(async (sandbox) =>
    scenario(await custodyFixture(sandbox, mode, sessionId)),
  );
}
function delivered(chatId = "-1003774691294") {
  return vi.fn().mockResolvedValue({ messageId: "delivered", chatId });
}
function rejectBeforeDispatch(retryable?: boolean) {
  return new PlatformMessageNotDispatchedError("Synthetic rejection", {
    cause: undefined,
    retryable,
  });
}

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  events.resetSystemEventsForTest();
});
afterEach(() => {
  events.resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it.for([
  "before platform dispatch",
  "ambiguous transport",
  "identityless transport",
  "confirmed delivery",
  "acknowledgment delivery",
  "permanent rejection settlement",
] as const)(
  "preserves delivery custody when a coalesced peer is stopped during %s",
  async (stage, test) =>
    withCustody(
      async ({ cfg, sessionKey, route, run: runWith, replySpy }) => {
        const sendsAck = stage === "acknowledgment delivery";
        const beforeDispatch = stage === "before platform dispatch";
        const unknownDelivery =
          stage === "ambiguous transport" || stage === "identityless transport";
        if (sendsAck) {
          cfg.channels = {
            ...cfg.channels,
            defaults: { heartbeatVisibility: { showOk: true } },
          };
        }
        const captureOwner = (runId: string) => {
          const identity = { runId, sessionKey, sessionId: "completion-owners", agentId: "main" };
          return exec.withExecRequestTurn({ identity }, async () => {
            const owner = exec.captureExecRequestOwners(identity)?.[0];
            if (!owner) {
              throw new Error("Expected the completion's request owner");
            }
            return owner;
          });
        };
        const stoppedOwner = await captureOwner("stopped-request");
        const liveOwner = await captureOwner("live-request");
        const enqueue = (name: string, owner: typeof liveOwner) =>
          events.enqueueSystemEventEntry(
            `Exec completed (${name}, code 0) :: ${name}`,
            exec.withExecRequestOwners(
              { sessionKey, contextKey: `exec:${name}`, deliveryContext: route },
              [owner],
            ),
          );
        const stopped = enqueue("STOPPED_RESULT", stoppedOwner);
        const live = enqueue("LIVE_RESULT", liveOwner);
        expect([stopped?.id, live?.id]).toEqual([expect.any(String), expect.any(String)]);
        replySpy.mockImplementation(async (ctx) =>
          createHeartbeatToolResponsePayload({
            outcome: "done",
            notify: !sendsAck,
            summary: "Completion results reviewed",
            notificationText: sendsAck
              ? undefined
              : ctx.Body?.includes("STOPPED_RESULT")
                ? "Combined completion result"
                : "Live peer completion result",
          }),
        );
        const entered = createDeferred();
        const release = createDeferred();
        const pause = async () => {
          entered.resolve();
          await release.promise;
        };
        const received: string[] = [];
        const telegram = vi.fn().mockImplementation(async (_to: string, text: string) => {
          received.push(text);
          return { messageId: "live-peer", chatId: "-1003774691294" };
        });
        if (sendsAck) {
          const send = durableMessages.sendDurableMessageBatchCore;
          vi.spyOn(durableMessages, "sendDurableMessageBatchCore").mockImplementationOnce(
            async (...args) => {
              const result = await send(...args);
              expect(result.status).toBe("sent");
              await pause();
              return result;
            },
          );
        } else if (beforeDispatch) {
          const startLease = deliveryLease.startDeliveryProducerLease;
          vi.spyOn(deliveryLease, "startDeliveryProducerLease").mockImplementationOnce(
            async (params) => {
              const lease = await startLease(params);
              await pause();
              return lease;
            },
          );
        } else if (unknownDelivery) {
          telegram.mockImplementationOnce(async (_to: string, text: string) => {
            received.push(text);
            await pause();
            if (stage === "identityless transport") {
              return {};
            }
            throw new Error("Synthetic response lost after platform dispatch");
          });
        } else if (stage === "confirmed delivery") {
          const patch = sessionAccessor.patchSessionEntryCore;
          let gated = false;
          vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementation(async (...args) => {
            const result = await patch(...args);
            if (received.length === 1 && !gated) {
              gated = true;
              await pause();
            }
            return result;
          });
        } else {
          telegram.mockRejectedValueOnce(rejectBeforeDispatch(false));
          const persist = heartbeatOutcomes.persistHeartbeatOutcome;
          vi.spyOn(heartbeatOutcomes, "persistHeartbeatOutcome").mockImplementationOnce(
            async (params) => {
              await persist(params);
              // Native rejection has released delivery custody; only heartbeat settlement remains.
              await pause();
            },
          );
        }
        bindHeartbeatSend("telegram", telegram);
        const run = () => runWith({ intent: "event" });
        const pending = run();
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              entered.promise,
              pending,
              "completion settled before the cancellation gate",
            ),
            test.signal,
          );
          expect(replySpy.mock.calls[0]?.[0].Body).toContain("STOPPED_RESULT");
          expect(replySpy.mock.calls[0]?.[0].Body).toContain("LIVE_RESULT");
          expect(telegram).toHaveBeenCalledTimes(beforeDispatch ? 0 : 1);
          expect(await loadPendingDeliveries()).toHaveLength(
            unknownDelivery || beforeDispatch ? 1 : 0,
          );
          exec.cancelExecRequestOwners([stoppedOwner]);
          release.resolve();
          expect(liveOwner.signal.aborted).toBe(false);
          if (unknownDelivery || stage === "confirmed delivery" || sendsAck) {
            expect(await pending).toEqual({ status: "skipped", reason: "no-pending-event" });
            expect(received).toEqual([
              expect.stringContaining(sendsAck ? "HEARTBEAT_OK" : "Combined completion result"),
            ]);
            expect(events.peekSystemEventEntries(sessionKey)).toEqual([]);
            expect(await run()).toEqual({ status: "skipped", reason: "no-pending-event" });
            expect(replySpy).toHaveBeenCalledOnce();
            expect(telegram).toHaveBeenCalledOnce();
            const recovery = await loadPendingDeliveries();
            if (unknownDelivery) {
              expect(recovery).toHaveLength(1);
              expect(recovery[0]).toMatchObject({
                to: route.to,
                accountId: "work",
                threadId: 47,
                recoveryState: "unknown_after_send",
              });
              const recoverSend = vi.fn();
              await drainPendingDeliveriesCore({
                cfg,
                deliver: recoverSend,
                log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
                drainKey: "cancelled-coalesced-completion",
                logLabel: "cancelled coalesced completion",
                selectEntry: (entry) => ({
                  match: entry.id === recovery[0]?.id,
                  bypassBackoff: true,
                }),
              });
              expect(recoverSend).not.toHaveBeenCalled();
              expect(await loadPendingDeliveries()).toEqual([]);
              expect(await run()).toEqual({ status: "skipped", reason: "no-pending-event" });
              expect(replySpy).toHaveBeenCalledOnce();
              expect(telegram).toHaveBeenCalledOnce();
              expect(received).toHaveLength(1);
            } else {
              expect(recovery).toEqual([]);
            }
            return;
          }
          expect(await pending).toEqual({ status: "skipped", reason: "preempted" });
          expect(events.peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual([
            live?.id,
          ]);
          expect(
            events.peekDeliverableSystemEventEntries(sessionKey).map((event) => event.id),
          ).toEqual([live?.id]);

          expect((await run()).status).toBe("ran");
          expect(replySpy).toHaveBeenCalledTimes(2);
          expect(replySpy.mock.calls[1]?.[0].Body).toContain("LIVE_RESULT");
          expect(replySpy.mock.calls[1]?.[0].Body).not.toContain("STOPPED_RESULT");
          expect(telegram).toHaveBeenCalledTimes(beforeDispatch ? 1 : 2);
          expect(telegram.mock.calls.at(-1)?.[1]).toContain("Live peer completion result");
          expect(received).toEqual([expect.stringContaining("Live peer completion result")]);
          expect(events.peekSystemEventEntries(sessionKey)).toEqual([]);
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
        }
      },
      "captured",
      "completion-owners",
    ),
);

it("recovers original-route custody after queue transaction rollback", async () =>
  withCustody(async ({ sessionKey, route, run, enqueue, replySpy }) => {
    enqueue("queue-admission", "original result");
    replySpy.mockResolvedValue({ text: "Original completion without a pending-final marker" });
    const telegram = delivered();
    bindHeartbeatSend("telegram", telegram);
    // Admit the schema before injecting failure at queue publication.
    const warmup = await enqueueDelivery({
      ...route,
      payloads: [{ text: "writer admission only" }],
    });
    await ackDelivery(warmup);
    const { db } = openOpenClawStateDatabase();
    db.exec(
      "CREATE TRIGGER reject_test_delivery BEFORE INSERT ON delivery_queue_entries WHEN NEW.queue_name = 'outbound-prepared-v1' BEGIN SELECT RAISE(ABORT, 'synthetic required queue publication failure'); END",
    );
    try {
      const failed = await run();
      expect(getLastHeartbeatEvent()?.reason).toContain(
        "Delivery queue admission rejected before publication",
      );
      expect(failed).toMatchObject({
        status: "skipped",
        reason: "channel-not-ready",
        retryAtMs: expect.any(Number),
      });
    } finally {
      db.exec("DROP TRIGGER reject_test_delivery");
    }
    expect(telegram).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries()).toHaveLength(0);
    expect(events.peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(1);
    await run();
    expect(telegram).toHaveBeenCalledExactlyOnceWith(
      route.to,
      expect.stringContaining("Original completion"),
      expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
    );
    expect(events.peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(0);
  }));

it.each(["rejected", "ambiguous"] as const)(
  "does not regenerate %s queued completion on another route",
  async (kind) =>
    withCustody(async ({ sessionKey, route, run, enqueue, replySpy, echoSelected }) => {
      enqueue("held-custody", "ORIGINAL_QUEUED_RESULT");
      echoSelected("ORIGINAL_QUEUED_RESULT", "OTHER_ROUTE_RESULT");
      const telegram = delivered().mockRejectedValueOnce(
        kind === "ambiguous" ? new Error("response lost after dispatch") : rejectBeforeDispatch(),
      );
      bindHeartbeatSend("telegram", telegram);
      await run();
      expect(telegram).toHaveBeenCalledOnce();
      const held = await loadPendingDeliveries();
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ to: route.to, accountId: "work", threadId: 47 });
      expect(events.peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(0);
      enqueue("other-route", "OTHER_ROUTE_RESULT", {
        ...route,
        to: "telegram:-1003774691294:topic:48",
        threadId: 48,
      });
      await run();
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[1]?.[0].Body).not.toContain("ORIGINAL_QUEUED_RESULT");
      expect(telegram).toHaveBeenCalledTimes(2);
      expect(telegram.mock.calls[1]?.[0]).toBe("telegram:-1003774691294:topic:48");
      expect((await loadPendingDeliveries()).map((entry) => entry.id)).toEqual(
        held.map((entry) => entry.id),
      );
    }),
);

it.each(["exec", "notice", "invalid-exec"] as const)(
  "does not combine an unbound legacy completion with a captured %s route",
  async (kind) =>
    withCustody(async ({ sessionKey, route, run, replySpy, echoSelected }) => {
      events.enqueueSystemEvent("Exec completed (legacy-first, code 0) :: LEGACY_ONLY", {
        sessionKey,
        contextKey: "exec:legacy-first",
      });
      events.enqueueSystemEvent("Exec completed (captured-second, code 0) :: CAPTURED_ONLY", {
        sessionKey,
        contextKey: (kind === "invalid-exec" ? "exec" : kind) + ":captured-second",
        deliveryContext: { ...route, threadId: kind === "invalid-exec" ? 99 : 47 },
      });
      echoSelected("LEGACY_ONLY", "CAPTURED_ONLY");
      const telegram = delivered("123456789");
      bindHeartbeatSend("telegram", telegram);
      await run();
      expect(replySpy.mock.calls[0]?.[0].Body).toContain("LEGACY_ONLY");
      expect(replySpy.mock.calls[0]?.[0].Body).not.toContain("CAPTURED_ONLY");
      if (kind !== "exec") {
        expect(telegram.mock.calls[0]?.[0]).toBe("telegram:123456789");
        return;
      }
      await run();
      expect(replySpy.mock.calls[1]?.[0].Body).toContain("CAPTURED_ONLY");
      expect(replySpy.mock.calls[1]?.[0].Body).not.toContain("LEGACY_ONLY");
      expect(telegram.mock.calls[1]?.[0]).toBe("telegram:-1003774691294:topic:47");
    }, "legacy"),
);

it("continues deferred routes after permanent rejection without replay", async () =>
  withCustody(async ({ cfg, sessionKey, route, enqueue, replySpy, echoSelected }) => {
    for (const [name, threadId] of [
      ["REJECTED", 47],
      ["DEFERRED", 48],
    ] as const) {
      enqueue(name, name, { ...route, to: "telegram:-1003774691294:topic:" + threadId, threadId });
    }
    echoSelected("REJECTED", "DEFERRED");
    const telegram = delivered().mockRejectedValueOnce(rejectBeforeDispatch(false));
    bindHeartbeatSend("telegram", telegram);
    const done = createDeferred();
    let calls = 0;
    setHeartbeatWakeHandler(async (options) => {
      const result = await runHeartbeatOnce({
        ...options,
        cfg,
      });
      if (++calls === 2) {
        done.resolve();
      }
      return result;
    });
    try {
      await requestHeartbeatAndWait({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sessionKey,
        agentId: "main",
        coalesceMs: 0,
      });
      await done.promise;
      expect(telegram).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[1]?.[0].Body).toContain("DEFERRED");
      expect(replySpy.mock.calls[1]?.[0].Body).not.toContain("REJECTED");
      expect(await loadPendingDeliveries()).toHaveLength(0);
      expect(events.peekSystemEventEntries(sessionKey)).toEqual([]);
      for (let index = 0; index < 20; index++) {
        expect(
          events.enqueueSystemEvent(`Ordinary notification ${index}`, {
            sessionKey,
            contextKey: `notice:capacity-${index}`,
          }),
        ).toBe(true);
      }
      expect(events.peekSystemEventEntries(sessionKey)).toHaveLength(20);
    } finally {
      setHeartbeatWakeHandler(null);
    }
  }));

it("does not let an uninspected exec route retarget an interval heartbeat", async () =>
  withCustody(async ({ sessionKey, run, enqueue, replySpy }) => {
    enqueue("not-selected", "PRIVATE_EXEC_RESULT");
    replySpy.mockResolvedValue({ text: "Scheduled monitor output" });
    const telegram = delivered("123456789");
    bindHeartbeatSend("telegram", telegram);
    await run({ source: "interval", reason: "interval" });
    expect(replySpy.mock.calls[0]?.[0].Body).not.toContain("PRIVATE_EXEC_RESULT");
    expect(telegram).toHaveBeenCalledExactlyOnceWith(
      "123456789",
      expect.stringContaining("Scheduled monitor output"),
      expect.objectContaining({ accountId: "personal" }),
    );
    expect(events.peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(1);
  }, "personal"));

it.each([true, false])(
  "separates same-route tagged and untagged completions (tagged first=%s)",
  async (taggedFirst) =>
    withCustody(async ({ sessionKey, route, run, replySpy, echoSelected }) => {
      for (const tagged of [taggedFirst, !taggedFirst]) {
        events.enqueueSystemEvent(
          `Exec completed (${tagged ? "tagged" : "untagged"}, code 0) :: ${tagged ? "TAGGED_RESULT" : "UNTRUSTED_RESULT"}`,
          {
            sessionKey,
            deliveryContext: route,
            ...(tagged ? { contextKey: "exec:tagged" } : {}),
          },
        );
      }
      echoSelected("TAGGED_RESULT", "UNTRUSTED_RESULT");
      const telegram = delivered("123456789");
      bindHeartbeatSend("telegram", telegram);
      await run();
      expect(replySpy.mock.calls[0]?.[0].Body).not.toContain(
        taggedFirst ? "UNTRUSTED_RESULT" : "TAGGED_RESULT",
      );
      await run();
      expect(replySpy.mock.calls[1]?.[0].Body).not.toContain(
        taggedFirst ? "TAGGED_RESULT" : "UNTRUSTED_RESULT",
      );
      expect(telegram.mock.calls[taggedFirst ? 0 : 1]?.[0]).toBe(route.to);
      expect(telegram.mock.calls[taggedFirst ? 1 : 0]?.[0]).toBe("123456789");
    }, "personal"),
);
