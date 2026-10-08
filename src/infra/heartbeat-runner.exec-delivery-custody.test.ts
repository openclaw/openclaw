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
import {
  cancelExecRequestOwners,
  captureExecRequestOwners,
  withExecRequestOwners,
  withExecRequestTurn,
} from "./exec-request-context.js";
import { getLastHeartbeatEvent } from "./heartbeat-events.js";
import * as heartbeatOutcomes from "./heartbeat-outcome-store.js";
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
import {
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekDeliverableSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});
afterEach(() => {
  resetSystemEventsForTest();
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
  async (stage, test) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
      const sendsAck = stage === "acknowledgment delivery";
      if (sendsAck) {
        cfg.channels = {
          ...cfg.channels,
          defaults: { heartbeatVisibility: { showOk: true } },
        };
      }
      const route = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        sessionId: "completion-owners",
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: route.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      const captureOwner = (runId: string) => {
        const identity = { runId, sessionKey, sessionId: "completion-owners", agentId: "main" };
        return withExecRequestTurn({ identity }, async () => {
          const owner = captureExecRequestOwners(identity)?.[0];
          if (!owner) {
            throw new Error("Expected the completion's request owner");
          }
          return owner;
        });
      };
      const stoppedOwner = await captureOwner("stopped-request");
      const liveOwner = await captureOwner("live-request");
      const enqueue = (name: string, owner: typeof liveOwner) =>
        enqueueSystemEventEntry(
          `Exec completed (${name}, code 0) :: ${name}`,
          withExecRequestOwners(
            { sessionKey, contextKey: `exec:${name}`, deliveryContext: route },
            [owner],
          ),
        );
      const stopped = enqueue("STOPPED_RESULT", stoppedOwner);
      const live = enqueue("LIVE_RESULT", liveOwner);
      expect(stopped?.id).toEqual(expect.any(String));
      expect(live?.id).toEqual(expect.any(String));
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
            entered.resolve();
            await release.promise;
            return result;
          },
        );
      } else if (stage === "before platform dispatch") {
        const startLease = deliveryLease.startDeliveryProducerLease;
        vi.spyOn(deliveryLease, "startDeliveryProducerLease").mockImplementationOnce(
          async (params) => {
            const lease = await startLease(params);
            entered.resolve();
            await release.promise;
            return lease;
          },
        );
      } else if (stage === "ambiguous transport" || stage === "identityless transport") {
        telegram.mockImplementationOnce(async (_to: string, text: string) => {
          received.push(text);
          entered.resolve();
          await release.promise;
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
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      } else {
        telegram.mockRejectedValueOnce(
          new PlatformMessageNotDispatchedError("Permanent synthetic rejection", {
            cause: undefined,
            retryable: false,
          }),
        );
        const persist = heartbeatOutcomes.persistHeartbeatOutcome;
        vi.spyOn(heartbeatOutcomes, "persistHeartbeatOutcome").mockImplementationOnce(
          async (params) => {
            await persist(params);
            // Native rejection has released delivery custody; only heartbeat settlement remains.
            entered.resolve();
            await release.promise;
          },
        );
      }
      const run = () =>
        runHeartbeatOnce({
          cfg,
          sessionKey,
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          deps: { getReplyFromConfig: replySpy, telegram },
        });
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
        expect(telegram).toHaveBeenCalledTimes(stage === "before platform dispatch" ? 0 : 1);
        expect(await loadPendingDeliveries()).toHaveLength(
          stage === "ambiguous transport" ||
            stage === "identityless transport" ||
            stage === "before platform dispatch"
            ? 1
            : 0,
        );
        cancelExecRequestOwners([stoppedOwner]);
        release.resolve();
        expect(liveOwner.signal.aborted).toBe(false);
        if (
          stage === "ambiguous transport" ||
          stage === "identityless transport" ||
          stage === "confirmed delivery" ||
          sendsAck
        ) {
          expect(await pending).toEqual({ status: "skipped", reason: "no-pending-event" });
          expect(received).toEqual([
            expect.stringContaining(sendsAck ? "HEARTBEAT_OK" : "Combined completion result"),
          ]);
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          expect(await run()).toEqual({ status: "skipped", reason: "no-pending-event" });
          expect(replySpy).toHaveBeenCalledOnce();
          expect(telegram).toHaveBeenCalledOnce();
          const recovery = await loadPendingDeliveries();
          if (stage === "ambiguous transport" || stage === "identityless transport") {
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
        expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual([live?.id]);
        expect(peekDeliverableSystemEventEntries(sessionKey).map((event) => event.id)).toEqual([
          live?.id,
        ]);

        expect((await run()).status).toBe("ran");
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(replySpy.mock.calls[1]?.[0].Body).toContain("LIVE_RESULT");
        expect(replySpy.mock.calls[1]?.[0].Body).not.toContain("STOPPED_RESULT");
        expect(telegram).toHaveBeenCalledTimes(stage === "before platform dispatch" ? 1 : 2);
        expect(telegram.mock.calls.at(-1)?.[1]).toContain("Live peer completion result");
        expect(received).toEqual([expect.stringContaining("Live peer completion result")]);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    });
  },
);

it.each(["schema admission", "transaction rollback"] as const)(
  "retains a proven unqueued completion for original-route recovery after %s",
  async (phase) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
      const route = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: route.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      enqueueSystemEvent("Exec completed (queue-admission, code 0) :: original result", {
        sessionKey,
        contextKey: "exec:queue-admission",
        deliveryContext: route,
      });
      replySpy.mockResolvedValue({ text: "Original completion without a pending-final marker" });
      const telegram = vi
        .fn()
        .mockResolvedValue({ messageId: "delivered", chatId: "-1003774691294" });
      // Admit the native writer before injecting the transaction failure. Schema
      // admission itself is not the publication boundary under test.
      if (phase === "transaction rollback") {
        const warmup = await enqueueDelivery({
          ...route,
          payloads: [{ text: "writer admission only" }],
        });
        await ackDelivery(warmup);
      }
      const { db } = openOpenClawStateDatabase();
      db.exec(
        "CREATE TRIGGER reject_test_delivery BEFORE INSERT ON delivery_queue_entries WHEN NEW.queue_name = 'outbound-prepared-v1' BEGIN SELECT RAISE(ABORT, 'synthetic required queue publication failure'); END",
      );
      try {
        const failed = await runHeartbeatOnce({
          cfg,
          sessionKey,
          source: "exec-event",
          reason: "exec-event",
          deps: { getReplyFromConfig: replySpy, telegram },
        });
        expect(getLastHeartbeatEvent()?.reason).toContain(
          phase === "transaction rollback"
            ? "Delivery queue admission rejected before publication"
            : "unexpected trigger reject_test_delivery",
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
      expect(peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(1);
      await runHeartbeatOnce({
        cfg,
        sessionKey,
        source: "exec-event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      expect(telegram).toHaveBeenCalledExactlyOnceWith(
        route.to,
        expect.stringContaining("Original completion"),
        expect.objectContaining({ accountId: "work", messageThreadId: 47 }),
      );
      expect(peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(0);
    });
  },
);

it.each(["rejected", "ambiguous"] as const)(
  "does not regenerate %s queued completion on another route",
  async (kind) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
      const route = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: route.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      enqueueSystemEvent("Exec completed (held-custody, code 0) :: ORIGINAL_QUEUED_RESULT", {
        sessionKey,
        contextKey: "exec:held-custody",
        deliveryContext: route,
      });
      replySpy.mockImplementation(async (ctx) => ({
        text: ctx.Body?.includes("ORIGINAL_QUEUED_RESULT")
          ? "ORIGINAL_QUEUED_RESULT"
          : "OTHER_ROUTE_RESULT",
      }));
      const telegram = vi
        .fn()
        .mockRejectedValueOnce(
          kind === "ambiguous"
            ? new Error("response lost after dispatch")
            : new PlatformMessageNotDispatchedError("rejected before provider dispatch", {
                cause: undefined,
              }),
        )
        .mockResolvedValue({ messageId: "other", chatId: "-1003774691294" });
      const deps = { getReplyFromConfig: replySpy, telegram };
      await runHeartbeatOnce({ cfg, sessionKey, source: "exec-event", reason: "exec-event", deps });
      expect(telegram).toHaveBeenCalledOnce();
      const held = await loadPendingDeliveries();
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ to: route.to, accountId: "work", threadId: 47 });
      expect(peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(0);
      enqueueSystemEvent("Exec completed (other-route, code 0) :: OTHER_ROUTE_RESULT", {
        sessionKey,
        contextKey: "exec:other-route",
        deliveryContext: { ...route, to: "telegram:-1003774691294:topic:48", threadId: 48 },
      });
      await runHeartbeatOnce({ cfg, sessionKey, source: "exec-event", reason: "exec-event", deps });
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[1]?.[0].Body).not.toContain("ORIGINAL_QUEUED_RESULT");
      expect(telegram).toHaveBeenCalledTimes(2);
      expect(telegram.mock.calls[1]?.[0]).toBe("telegram:-1003774691294:topic:48");
      expect((await loadPendingDeliveries()).map((entry) => entry.id)).toEqual(
        held.map((entry) => entry.id),
      );
    });
  },
);

it.each(["exec", "notice", "invalid-exec"] as const)(
  "does not combine an unbound legacy completion with a captured %s route",
  async (kind) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "telegram:123456789",
        lastAccountId: "personal",
      });
      enqueueSystemEvent("Exec completed (legacy-first, code 0) :: LEGACY_ONLY", {
        sessionKey,
        contextKey: "exec:legacy-first",
      });
      enqueueSystemEvent("Exec completed (captured-second, code 0) :: CAPTURED_ONLY", {
        sessionKey,
        contextKey: (kind === "invalid-exec" ? "exec" : kind) + ":captured-second",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          accountId: "work",
          threadId: kind === "invalid-exec" ? 99 : 47,
        },
      });
      replySpy.mockImplementation(async (ctx) => ({
        text: ctx.Body?.includes("LEGACY_ONLY") ? "LEGACY_ONLY" : "CAPTURED_ONLY",
      }));
      const telegram = vi.fn().mockResolvedValue({ messageId: "done", chatId: "123456789" });
      const deps = { getReplyFromConfig: replySpy, telegram };
      await runHeartbeatOnce({ cfg, sessionKey, source: "exec-event", reason: "exec-event", deps });
      expect(replySpy.mock.calls[0]?.[0].Body).toContain("LEGACY_ONLY");
      expect(replySpy.mock.calls[0]?.[0].Body).not.toContain("CAPTURED_ONLY");
      if (kind !== "exec") {
        expect(telegram.mock.calls[0]?.[0]).toBe("telegram:123456789");
        return;
      }
      await runHeartbeatOnce({ cfg, sessionKey, source: "exec-event", reason: "exec-event", deps });
      expect(replySpy.mock.calls[1]?.[0].Body).toContain("CAPTURED_ONLY");
      expect(replySpy.mock.calls[1]?.[0].Body).not.toContain("LEGACY_ONLY");
      expect(telegram.mock.calls[1]?.[0]).toBe("telegram:-1003774691294:topic:47");
    });
  },
);

it("continues a deferred route after permanent rejection without replaying the rejected exec", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
    const route = {
      channel: "telegram",
      to: "telegram:-1003774691294:topic:47",
      accountId: "work",
      threadId: 47,
    };
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: route.to,
      lastAccountId: "work",
      lastThreadId: 47,
    });
    for (const [name, threadId] of [
      ["REJECTED", 47],
      ["DEFERRED", 48],
    ] as const) {
      enqueueSystemEvent("Exec completed (" + name.toLowerCase() + ", code 0) :: " + name, {
        sessionKey,
        contextKey: "exec:" + name,
        deliveryContext: { ...route, to: "telegram:-1003774691294:topic:" + threadId, threadId },
      });
    }
    replySpy.mockImplementation(async (ctx) => ({
      text: ctx.Body?.includes("REJECTED") ? "REJECTED" : "DEFERRED",
    }));
    const telegram = vi
      .fn()
      .mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("Permanent synthetic rejection", {
          cause: undefined,
          retryable: false,
        }),
      )
      .mockResolvedValue({ messageId: "deferred", chatId: "-1003774691294" });
    const done = createDeferred();
    let calls = 0;
    setHeartbeatWakeHandler(async (options) => {
      const result = await runHeartbeatOnce({
        ...options,
        cfg,
        deps: { getReplyFromConfig: replySpy, telegram },
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
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      for (let index = 0; index < 20; index++) {
        expect(
          enqueueSystemEvent(`Ordinary notification ${index}`, {
            sessionKey,
            contextKey: `notice:capacity-${index}`,
          }),
        ).toBe(true);
      }
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(20);
    } finally {
      setHeartbeatWakeHandler(null);
    }
  });
});

it("does not let an uninspected exec route retarget an interval heartbeat", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
    cfg.agents!.defaults!.heartbeat = {
      ...cfg.agents!.defaults!.heartbeat,
      target: "telegram",
      to: "123456789",
      accountId: "personal",
    };
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "123456789",
      lastAccountId: "personal",
    });
    enqueueSystemEvent("Exec completed (not-selected, code 0) :: PRIVATE_EXEC_RESULT", {
      sessionKey,
      contextKey: "exec:not-selected",
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      },
    });
    replySpy.mockResolvedValue({ text: "Scheduled monitor output" });
    const telegram = vi.fn().mockResolvedValue({ messageId: "monitor", chatId: "123456789" });
    await runHeartbeatOnce({
      cfg,
      sessionKey,
      source: "interval",
      reason: "interval",
      deps: { getReplyFromConfig: replySpy, telegram },
    });
    expect(replySpy.mock.calls[0]?.[0].Body).not.toContain("PRIVATE_EXEC_RESULT");
    expect(telegram).toHaveBeenCalledExactlyOnceWith(
      "123456789",
      expect.stringContaining("Scheduled monitor output"),
      expect.objectContaining({ accountId: "personal" }),
    );
    expect(peekDeliverableSystemEventEntries(sessionKey)).toHaveLength(1);
  });
});

it("does not grant captured exec authority to an untagged look-alike event", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
    cfg.agents!.defaults!.heartbeat = {
      ...cfg.agents!.defaults!.heartbeat,
      target: "telegram",
      to: "123456789",
      accountId: "personal",
    };
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "123456789",
      lastAccountId: "personal",
    });
    enqueueSystemEvent("Exec completed (lookalike, code 0) :: LOOKALIKE", {
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      },
    });
    replySpy.mockResolvedValue({ text: "Legacy notice" });
    const telegram = vi.fn().mockResolvedValue({ messageId: "notice", chatId: "123456789" });
    await runHeartbeatOnce({
      cfg,
      sessionKey,
      source: "exec-event",
      reason: "exec-event",
      deps: { getReplyFromConfig: replySpy, telegram },
    });
    expect(telegram).toHaveBeenCalledExactlyOnceWith(
      "123456789",
      expect.stringContaining("Legacy notice"),
      expect.objectContaining({ accountId: "personal" }),
    );
  });
});

it.each([true, false])(
  "separates same-route tagged and untagged completions (tagged first=%s)",
  async (taggedFirst) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      cfg.agents!.defaults!.heartbeat = {
        ...cfg.agents!.defaults!.heartbeat,
        target: "telegram",
        to: "123456789",
        accountId: "personal",
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123456789",
        lastAccountId: "personal",
      });
      const route = {
        channel: "telegram",
        to: "telegram:-1003774691294:topic:47",
        accountId: "work",
        threadId: 47,
      };
      for (const tagged of [taggedFirst, !taggedFirst]) {
        enqueueSystemEvent(
          "Exec completed (" +
            (tagged ? "tagged" : "untagged") +
            ", code 0) :: " +
            (tagged ? "TAGGED_RESULT" : "UNTRUSTED_RESULT"),
          { sessionKey, deliveryContext: route, ...(tagged ? { contextKey: "exec:tagged" } : {}) },
        );
      }
      replySpy.mockImplementation(async (ctx) => ({
        text: ctx.Body?.includes("TAGGED_RESULT") ? "TAGGED_RESULT" : "UNTRUSTED_RESULT",
      }));
      const telegram = vi.fn().mockResolvedValue({ messageId: "receipt", chatId: "123456789" });
      const deps = { getReplyFromConfig: replySpy, telegram };
      await runHeartbeatOnce({ cfg, sessionKey, source: "exec-event", reason: "exec-event", deps });
      expect(replySpy.mock.calls[0]?.[0].Body).not.toContain(
        taggedFirst ? "UNTRUSTED_RESULT" : "TAGGED_RESULT",
      );
      await runHeartbeatOnce({ cfg, sessionKey, source: "exec-event", reason: "exec-event", deps });
      expect(replySpy.mock.calls[1]?.[0].Body).not.toContain(
        taggedFirst ? "TAGGED_RESULT" : "UNTRUSTED_RESULT",
      );
      expect(telegram.mock.calls[taggedFirst ? 0 : 1]?.[0]).toBe(route.to);
      expect(telegram.mock.calls[taggedFirst ? 1 : 0]?.[0]).toBe("123456789");
    });
  },
);
