import "./server-restart-sentinel.test-harness.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunNotice, renderUpdateRunSummary } from "../infra/update-run-notice.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  createRestartSentinelTestFixture,
  sentinelFixture,
  sessionFixture,
  type RestartSentinel,
} from "./server-restart-sentinel-fixtures.test-support.js";
import {
  expectRestartSentinelTranscriptBroadcast,
  expectRecordFields,
  mockCallArg,
  expectMockCallFields,
} from "./server-restart-sentinel.test-support.js";
import * as restartUpdateRun from "./server-restart-update-run.js";
import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";
import { createSessionRowProjection } from "./session-row-projection.js";

describe("scheduleRestartSentinelWake", () => {
  const fixture = createRestartSentinelTestFixture();
  const { actualRestartUpdateRun, mocks, expectQueueContext, setNoticeOwner, wakeRestartSentinel } =
    fixture;
  it("records a non-owner update without delivery or a diagnostic wake", async () => {
    const sessionKey = "agent:main:whatsapp:direct:+15550002";
    const run = createUpdateRun({ trigger: "control-ui", origin: { sessionKey } });
    const session = mocks.loadSessionEntry(sessionKey);
    setNoticeOwner("telegram:12345");
    mocks.loadSessionEntry.mockReturnValue({
      ...session,
      cfg: { commands: { ownerAllowFrom: ["telegram:12345"] } },
    });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "ok",
        ts: 123,
        sessionKey,
        deliveryContext: { channel: "whatsapp", to: "+15550002", accountId: "acct-2" },
        stats: { mode: "npm", runId: run.runId },
      }),
    );

    await wakeRestartSentinel();

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, fixture.queueContext.environment);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("target is not a current command owner"),
      expect.objectContaining({ runId: run.runId }),
    );
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(false);
  });

  it.each([
    { terminal: false, channel: "webchat" },
    { terminal: true, channel: "telegram" },
  ])(
    "uses the durable update outcome on boot ($channel, already terminal: $terminal)",
    async ({ terminal, channel }) => {
      const record = createUpdateRun({
        trigger: "api",
        before: { version: "2026.9.1" },
        target: { version: resolveRuntimeServiceVersion() },
      });
      const existing = terminal
        ? finishUpdateRun(record.runId, { status: "failed", reason: "post-update-plugins" })
        : record;
      mocks.deliveryContextFromSession.mockReturnValue({
        channel,
        ...(channel === "telegram" ? { to: "chat-123" } : {}),
      });
      mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({
        ok: true,
        target: {
          agentId: "main",
          sessionId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        messageId: "update-notice",
      });
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind: "update",
          status: "ok",
          ts: 123,
          sessionKey: "agent:main:main",
          stats: { runId: record.runId },
          doctorHint: "Run openclaw --profile work doctor --non-interactive.",
        }),
      );

      await wakeRestartSentinel();

      const result = getUpdateRun(record.runId)!;
      expect(result.status).toBe(terminal ? "failed" : "succeeded");
      expect(result.verification).toMatchObject(
        terminal
          ? { ...existing.verification, noticeDelivered: true }
          : {
              booted: true,
              serviceRunning: true,
              runningVersion: resolveRuntimeServiceVersion(),
              noticeDelivered: true,
              doctorHint: "Run openclaw --profile work doctor --non-interactive.",
            },
      );
      if (terminal) {
        expect(result.verification.booted).toBeUndefined();
        expect(result.verification.doctorHint).toBeUndefined();
      }
      if (terminal) {
        expect(result.finishedAtMs).toBe(existing.finishedAtMs);
      }
      const message = renderUpdateRunSummary(result);
      if (channel === "webchat") {
        expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
          expect.objectContaining({ text: message }),
        );
      } else {
        expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
          expect.objectContaining({ payloads: [{ text: message }] }),
        );
      }
    },
  );

  it.each([false, true])(
    "bounds pending notice retries while preserving CLI run ownership (%s)",
    async (cliFinished) => {
      // Exercise real SQLite at initial/expiry/finish boundaries, not 900
      // identical observations. Slow forked reads can outlive a fake-timer test.
      const finalize = actualRestartUpdateRun.finalizeRestartUpdateRun;
      let observedRun: Awaited<ReturnType<typeof finalize>>;
      const finalizeSpy = vi
        .mocked(restartUpdateRun.finalizeRestartUpdateRun)
        .mockImplementation(async (payload, expired) => {
          if (!observedRun || expired) {
            observedRun = await finalize(payload, expired);
          }
          return observedRun;
        });
      const record = createUpdateRun({
        trigger: "api",
        target: { version: resolveRuntimeServiceVersion() },
      });
      recordUpdateRunPhase(record.runId, "restarting");
      mocks.deliveryContextFromSession.mockReturnValue({ channel: "webchat" });
      mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({
        ok: true,
        target: {
          agentId: "main",
          sessionId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        messageId: "update-notice",
      });
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind: "update",
          status: "skipped",
          ts: 123,
          sessionKey: "agent:main:main",
          stats: {
            runId: record.runId,
            handoffId: "managed-update-handoff",
            reason: "restart-health-pending",
          },
        }),
      );

      await wakeRestartSentinel();
      expect(getUpdateRun(record.runId)?.status).toBe("running");
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "🔁 Checking that OpenClaw is ready…",
        }),
      );
      if (cliFinished) {
        observedRun = finishUpdateRun(record.runId, {
          status: "succeeded",
          after: { version: resolveRuntimeServiceVersion() },
        });
      }
      for (let attempt = 0; attempt < 899; attempt += 1) {
        await fixture.clock.advanceBy(2_000);
      }
      expect(mocks.clearSentinel).not.toHaveBeenCalled();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
      await fixture.clock.advanceBy(2_000);

      const result = getUpdateRun(record.runId)!;
      expect(result.status).toBe(cliFinished ? "succeeded" : "running");
      expect(result.reason).toBeNull();
      if (!cliFinished) {
        expect(result.finishedAtMs).toBeNull();
        expect(result.verification.noticeDelivered).toBeUndefined();
        expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
        expect(mocks.clearSentinel).not.toHaveBeenCalled();
        const readsAtExpiry = mocks.readRestartSentinel.mock.calls.length;
        await fixture.clock.advanceBy(1_800_000);
        expect(mocks.readRestartSentinel).toHaveBeenCalledTimes(readsAtExpiry);
        observedRun = finishUpdateRun(record.runId, {
          status: "succeeded",
          after: { version: resolveRuntimeServiceVersion() },
        });
        mocks.readRestartSentinel.mockResolvedValue(
          sentinelFixture(
            {
              kind: "update",
              status: "ok",
              ts: 124,
              sessionKey: "agent:main:main",
              stats: { runId: record.runId, handoffId: "managed-update-handoff" },
            },
            124,
          ),
        );
        await wakeRestartSentinel();
      }
      const completed = getUpdateRun(record.runId)!;
      expect(completed.status).toBe("succeeded");
      expect(completed.verification.noticeDelivered).toBe(true);
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          text: renderUpdateRunSummary(completed),
          idempotencyKey: `update-run-finished:${record.runId}`,
        }),
      );
      expect(mocks.clearSentinel).toHaveBeenCalledOnce();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
      const sentinelReads = mocks.readRestartSentinel.mock.calls.length;
      await fixture.clock.advanceBy(1_800_000);
      expect(mocks.readRestartSentinel).toHaveBeenCalledTimes(sentinelReads);
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
      expect(mocks.clearSentinel).toHaveBeenCalledOnce();
      finalizeSpy.mockRestore();
    },
  );

  it("appends and broadcasts the durable internal update outcome only once", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "internal-update-session";
    const storePath = fixture.testState.statePath("agents", "main", "sessions", "sessions.json");
    const entry = { sessionId, updatedAt: 1, lifecycleRevision: "update-lifecycle" };
    await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, entry);
    const originalMerge = mocks.mergeDeliveryContext.getMockImplementation()!;
    const sessionUtils =
      await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
    const delivery = await vi.importActual<typeof import("../utils/delivery-context.shared.js")>(
      "../utils/delivery-context.shared.js",
    );
    const deliveryRead = await vi.importActual<typeof import("../utils/delivery-context.read.js")>(
      "../utils/delivery-context.read.js",
    );
    mocks.loadSessionEntry.mockImplementation(sessionUtils.loadSessionEntry);
    mocks.deliveryContextFromSession.mockImplementation(deliveryRead.deliveryContextFromSession);
    mocks.mergeDeliveryContext.mockImplementation(delivery.mergeDeliveryContext);
    const updateRun = createUpdateRun({ trigger: "api", origin: { sessionKey } });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "ok",
        ts: 123,
        sessionKey,
        stats: { mode: "npm", runId: updateRun.runId },
      }),
    );
    const transcript = await vi.importActual<typeof import("../config/sessions/transcript.js")>(
      "../config/sessions/transcript.js",
    );
    mocks.appendAssistantMessageToSessionTranscript.mockImplementation(
      transcript.appendAssistantMessageToSessionTranscript,
    );
    const broadcastToConnIds = vi.fn();
    const subscribers = new Set(["control-ui-connection"]);
    const rowProjection = await createSessionRowProjection({
      cfg: { agents: { entries: { main: {} } }, session: { store: storePath } },
    });
    expect(rowProjection.capture({ agentId: "main", key: sessionKey })?.entry).toMatchObject({
      sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    });
    const publish = createTranscriptUpdateBroadcastHandler({
      getSessionRowProjection: () => rowProjection,
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => subscribers },
      sessionMessageSubscribers: { get: () => subscribers },
      chatAbortControllers: new Map(),
    });
    const publications: Promise<void>[] = [];
    const publicationErrors: unknown[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
      if (update.target?.sessionId === sessionId) {
        publications.push(
          publish(update).catch((error: unknown) => {
            publicationErrors.push(error);
          }),
        );
      }
    });
    try {
      const { createUpdateRunNotifier } = await import("./update-run-notice.runtime.js");
      const notify = await createUpdateRunNotifier(updateRun, () => ({}), {});
      expect.soft(await notify(updateRun, "ack")).toEqual({ delivered: true, owned: true });
      expect
        .soft(getUpdateRun(updateRun.runId)?.steps)
        .toContainEqual(expect.objectContaining({ step: "notice:ack", status: "completed" }));
      const ackEvents = await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      });
      expect.soft(ackEvents).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            idempotencyKey: `update-run-ack:${updateRun.runId}`,
            content: [{ type: "text", text: renderUpdateRunNotice(updateRun, "ack") }],
          }),
        }),
      );
      finishUpdateRun(updateRun.runId, { status: "succeeded" });
      await wakeRestartSentinel();
      await wakeRestartSentinel();
      await Promise.all(publications);
      expect(publicationErrors).toEqual([]);
      const finishedRun = getUpdateRun(updateRun.runId)!;
      const report = renderUpdateRunSummary(finishedRun);
      expect.soft(finishedRun?.verification.noticeDelivered).toBe(true);
      expect.soft(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect.soft(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey,
          expectedSessionId: sessionId,
          expectedLifecycleRevision: entry.lifecycleRevision,
          storePath,
          text: report,
          idempotencyKey: `update-run-finished:${updateRun.runId}`,
        }),
      );
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      });
      expect(events.filter((event) => asOptionalRecord(event)?.type === "message")).toHaveLength(2);
      expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
      expectRestartSentinelTranscriptBroadcast(broadcastToConnIds, {
        sessionKey,
        report,
        subscribers,
      });
      expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
      expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.logWarn).not.toHaveBeenCalled();
    } finally {
      mocks.mergeDeliveryContext.mockImplementation(originalMerge);
      unsubscribe();
      await Promise.allSettled(publications);
      rowProjection.dispose();
    }
  });

  it("wakes the internal session when the update notice append throws", async () => {
    mocks.deliveryContextFromSession.mockReturnValue({ channel: "webchat" });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "update", status: "error", ts: 123, sessionKey: "agent:main:main" }),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockRejectedValue(new Error("append failed"));

    await wakeRestartSentinel();

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: internal restart notice append failed; falling back to wake: append failed",
      { sessionKey: "agent:main:main" },
    );
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
  });

  it("persists every downstream intent before consuming the loaded revision", async () => {
    await wakeRestartSentinel();

    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, fixture.queueContext.environment);
    const clearOrder = mocks.clearSentinel.mock.invocationCallOrder[0] ?? 0;
    expect(mocks.enqueueSessionDelivery.mock.invocationCallOrder[0]).toBeLessThan(clearOrder);
    expect(mocks.enqueueDeliveryOnce.mock.invocationCallOrder[0]).toBeLessThan(clearOrder);
    expect(clearOrder).toBeLessThan(mocks.enqueueSessionEvent.mock.invocationCallOrder[0] ?? 0);
    expect(clearOrder).toBeLessThan(mocks.deliverOutboundPayloads.mock.invocationCallOrder[0] ?? 0);
  });

  it("stops delivery when guarded sentinel consumption fails", async () => {
    mocks.clearSentinel.mockRejectedValueOnce(new Error("database locked"));

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledOnce();
    expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledOnce();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      sessionKey: "agent:main:main",
      reason: "database locked",
    });
  });

  it("preserves a newer sentinel while draining durable work from the loaded revision", async () => {
    mocks.clearSentinel.mockResolvedValueOnce(false);

    await wakeRestartSentinel();

    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, fixture.queueContext.environment);
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledOnce();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "restart summary: newer restart sentinel preserved while draining durable work",
      { sessionKey: "agent:main:main" },
    );
  });

  it("does not resend a restart notice whose stable queue id is already owned", async () => {
    mocks.withStableDeliveryPreparation.mockResolvedValueOnce({ status: "existing" });
    mocks.findDeliveryIntentOwner.mockResolvedValueOnce({
      namespace: "prepared",
      status: "pending",
    });

    await wakeRestartSentinel();

    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, fixture.queueContext.environment);
    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "restart summary: durable restart notice already owned",
      { sessionKey: "agent:main:main" },
    );
  });

  it("queues the restart wake before a system-event continuation", async () => {
    mocks.readRestartSentinel.mockResolvedValueOnce(
      sentinelFixture({
        kind: "restart",
        status: "ok",
        ts: 99,
        sessionKey: "agent:main:main",
        continuation: { kind: "systemEvent", text: "continue" },
      }),
    );

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueSessionDelivery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: "restart message",
        idempotencyKey: "restart-sentinel-wake:agent:main:main:123",
        completionRetention: "permanent",
      }),
      expectQueueContext(),
    );
    expect(mocks.enqueueSessionDelivery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "continue",
        idempotencyKey: "restart-sentinel:agent:main:main:systemEvent:123",
        completionRetention: "permanent",
      }),
      expectQueueContext(),
    );
    expect(mocks.enqueueSessionEvent.mock.calls.map((call) => call[0])).toEqual([
      "restart message",
      "continue",
    ]);
  });

  it.each([
    { status: "completed", settlement: "recovered" },
    { status: "failed", settlement: "moved-to-failed" },
  ] as const)(
    "retains session-event custody through $status settlement",
    async ({ status, settlement }) => {
      const eventAdopted = createDeferred();
      const eventOutcome =
        createDeferred<
          import("../auto-reply/reply/session-event-contract.js").SessionEventOutcome
        >();
      const noticeDelivered = createDeferred();
      mocks.enqueueSessionEvent.mockImplementationOnce((_text, options) => ({
        id: "unfinished-restart-event",
        cancel: () => true,
        settled: Promise.resolve().then(async () => {
          await options.onAdopted?.();
          eventAdopted.resolve();
          return eventOutcome.promise;
        }),
      }));
      mocks.deliverOutboundPayloads.mockImplementationOnce(async () => {
        noticeDelivered.resolve();
        return [{ channel: "whatsapp", messageId: "restart-notice" }];
      });
      const recovery = wakeRestartSentinel();
      try {
        await awaitGateBeforeSettlement(
          Promise.all([eventAdopted.promise, noticeDelivered.promise]),
          recovery,
          "Restart recovery ended without delivering the notice and adopting its event",
        );
        expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
      } finally {
        eventOutcome.resolve({
          status,
          executionStarted: true,
          delivered: false,
          ...(status === "failed" ? { error: "transcript publication failed" } : {}),
        });
        await recovery;
      }
      expect(mocks.markSessionDeliverySettlement).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "systemEvent", completionRetention: "permanent" }),
        settlement,
        expectQueueContext(),
      );
    },
  );

  it("queues a failed outbound notice for durable recovery without dropping the agent wake", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("platform outcome unknown"));
    mocks.loadPendingDelivery
      .mockResolvedValueOnce({
        id: "restart-sentinel-notice:agent:main:main:123",
        retryCount: 1,
        lastError: "platform outcome unknown",
      } as never)
      .mockResolvedValue(null);

    await wakeRestartSentinel();

    expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      skipQueue: true,
      deliveryQueueId: "restart-sentinel-notice:agent:main:main:123",
    });
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery.mock.calls[0]?.slice(0, 2)).toEqual([
      "restart-sentinel-notice:agent:main:main:123",
      "platform outcome unknown",
    ]);
    expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
    expectRecordFields(mockCallArg(mocks.drainPendingDeliveries), {
      drainKey: "restart-recovery:restart-sentinel-notice:agent:main:main:123",
      deliver: expect.any(Function),
    });
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: outbound delivery failed; queued for recovery: Error: platform outcome unknown",
      {
        channel: "whatsapp",
        to: "+15550002",
        sessionKey: "agent:main:main",
      },
    );
  });

  it("delivers the activation Doctor rollback notice after the previous Gateway starts", async () => {
    const actualSentinel = await vi.importActual<typeof import("../infra/restart-sentinel.js")>(
      "../infra/restart-sentinel.js",
    );
    const { writeControlPlaneUpdateRestartSentinel } =
      await import("../infra/update-control-plane-sentinel.js");
    const sessionKey = "agent:ops:telegram:group:room-77";
    const run = createUpdateRun({
      trigger: "cli",
      origin: {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "room-77",
          accountId: "bot",
          threadId: "topic-7",
        },
      },
    });
    finishUpdateRun(run.runId, { status: "rolled-back", reason: "authority-check-failed" });
    await writeControlPlaneUpdateRestartSentinel({
      meta: { runId: run.runId, handoffId: "original-helper" },
      result: {
        status: "error",
        mode: "npm",
        reason: "authority-check-failed",
        steps: [],
        durationMs: 1,
      },
    });
    mocks.readRestartSentinel.mockResolvedValue(
      (await actualSentinel.readRestartSentinel()) as RestartSentinel,
    );
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "room-77" });
    setNoticeOwner("telegram:room-77");
    await wakeRestartSentinel();
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith(
      sessionKey,
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR }),
      }),
    );
    expect(mocks.resolveSystemMainSessionTarget).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "room-77",
        accountId: "bot",
        threadId: "topic-7",
        payloads: [
          expect.objectContaining({
            text: expect.stringContaining("returned to the previous version"),
          }),
        ],
      }),
    );
    expect(getUpdateRun(run.runId)).toMatchObject({
      status: "rolled-back",
      reason: "authority-check-failed",
      verification: { noticeDelivered: true },
    });
  });

  it.each([{ status: "failed", consumed: false }] as const)(
    "consumes only a targetless CLI outcome without a model wake ($status, $consumed)",
    async ({ status, consumed }) => {
      const run = createUpdateRun({ trigger: "cli" });
      const terminal = finishUpdateRun(run.runId, { status, reason: "original-cli-outcome" });
      mocks.clearSentinel.mockResolvedValueOnce(consumed);
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind: "update",
          status: "error",
          ts: 123,
          message: null,
          doctorHint: "Run openclaw doctor --non-interactive",
          stats: { runId: run.runId },
        }),
      );
      await wakeRestartSentinel();
      expect(mocks.clearSentinel).toHaveBeenCalledExactlyOnceWith(
        123,
        fixture.queueContext.environment,
      );
      expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(getUpdateRun(run.runId)).toEqual(terminal);
    },
  );

  it("preserves an explicit targetless CLI note", async () => {
    const run = createUpdateRun({ trigger: "cli" });
    finishUpdateRun(run.runId, { status: "failed" });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "error",
        ts: 123,
        message: "explicit follow-up",
        stats: { runId: run.runId },
      }),
    );
    await wakeRestartSentinel();
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({ sessionKey: "agent:ops:main" }),
    );
  });

  it("keeps a targetless Control UI update out of the ambient chat", async () => {
    const run = createUpdateRun({ trigger: "control-ui" });
    finishUpdateRun(run.runId, { status: "succeeded" });
    mocks.deliveryContextFromSession.mockReturnValue({ channel: "whatsapp", to: "+15550002" });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "update", status: "ok", ts: 123, stats: { runId: run.runId } }),
    );

    await wakeRestartSentinel();

    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.resolveSystemMainSessionTarget).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, fixture.queueContext.environment);
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(false);
  });

  it.each(["config-patch", "config-apply"] as const)(
    "consumes a targetless %s acknowledgement without waking an agent",
    async (kind) => {
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind,
          status: "ok",
          ts: 123,
          sessionKey: undefined,
          deliveryContext: undefined,
          threadId: undefined,
          message: null,
          doctorHint: "Run openclaw doctor --non-interactive",
          stats: {
            mode: kind === "config-patch" ? "config.patch" : "config.apply",
            root: "/tmp/openclaw.json",
            requiresRestart: true,
          },
        }),
      );

      await wakeRestartSentinel();

      expect(mocks.clearSentinel).toHaveBeenCalledOnce();
      expect(mocks.clearSentinel).toHaveBeenCalledWith(123, fixture.queueContext.environment);
      expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
    },
  );

  it("routes a targetless update through the system base session without resuming it", async () => {
    const baseSessionKey = "agent:ops:main";
    const sessionKey = `${baseSessionKey}:thread:99`;
    const context = { channel: "telegram", to: "123", accountId: "bot", threadId: "7" };
    mocks.resolveSystemMainSessionTarget.mockReturnValue({ agentId: "ops", sessionKey });
    mocks.parseSessionThreadInfo.mockImplementation((key?: string) => ({
      baseSessionKey: key === sessionKey ? baseSessionKey : key,
      threadId: key === sessionKey ? "99" : undefined,
    }));
    const loadSession = mocks.loadSessionEntry.getMockImplementation()!;
    mocks.loadSessionEntry.mockImplementation((key) => ({
      ...loadSession(key),
      entry: {
        sessionId: key,
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({
          context: key === baseSessionKey ? context : undefined,
        }),
      },
    }));
    const delivery = await vi.importActual<typeof import("../utils/delivery-context.read.js")>(
      "../utils/delivery-context.read.js",
    );
    mocks.deliveryContextFromSession.mockImplementation(delivery.deliveryContextFromSession);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    setNoticeOwner("telegram:123");
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "ok",
        ts: 123,
        continuation: { kind: "agentTurn", message: "must not continue an inferred session" },
      }),
    );

    await wakeRestartSentinel();

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "bot",
        threadId: "7",
        payloads: [
          {
            text: "✅ OpenClaw updated.\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
          },
        ],
      }),
    );
    const eventOptions = mocks.enqueueSessionEvent.mock.calls[0]?.[1];
    expect(eventOptions).toMatchObject({
      sessionKey,
      deliveryContext: context,
    });
    expect(eventOptions).toMatchObject({ source: "restart", agentId: "ops" });
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: continuation skipped: restart sentinel sessionKey unavailable",
      { sessionKey, continuationKind: "agentTurn" },
    );
  });

  it("records targetless non-delivery when system-agent ownership is missing", async () => {
    mocks.resolveSystemMainSessionTarget.mockImplementation(() => {
      throw new Error(
        "Multiple agents are configured, but system-agent consult routing has no explicit owner. Set agents.defaults.systemAgent.agentId or pass an explicit consult agent id.",
      );
    });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "restart", status: "ok", ts: 123, message: "restart message" }),
    );

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      reason: expect.stringContaining("Set agents.defaults.systemAgent.agentId"),
    });
  });

  it("resolves session routing before starting the session event", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:qa-channel:channel:qa-room",
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:qa-channel:channel:qa-room",
      threadId: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    const enqueueSessionEvent = mocks.enqueueSessionEvent.getMockImplementation()!;
    mocks.enqueueSessionEvent.mockImplementation((...args) => {
      mocks.deliveryContextFromSession.mockReturnValue({
        channel: "qa-channel",
        to: "event-turn",
      });
      return enqueueSessionEvent(...args);
    });
    mocks.resolveOutboundTarget.mockImplementation((params?: { to?: string }) => ({
      ok: true as const,
      to: params?.to ?? "missing",
    }));
    setNoticeOwner("channel:qa-room");

    await wakeRestartSentinel();

    expectMockCallFields(mocks.resolveOutboundTarget, {
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      channel: "qa-channel",
      to: "channel:qa-room",
    });
  });

  it("merges base session routing into partial thread metadata", async () => {
    setNoticeOwner("room:!MixedCase:example.org");
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      threadId: "$thread-event",
    });
    mocks.loadSessionEntry
      .mockReturnValueOnce(
        sessionFixture(
          "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
          {
            sessionId: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
            updatedAt: 0,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
              origin: { provider: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
            }),
          },
          { cfg: { commands: { ownerAllowFrom: ["room:!MixedCase:example.org"] } } },
        ),
      )
      .mockReturnValueOnce(
        sessionFixture("agent:main:matrix:channel:!lowercased:example.org", {
          sessionId: "agent:main:matrix:channel:!lowercased:example.org",
          updatedAt: 0,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "room:!MixedCase:example.org" },
          }),
        }),
      );
    mocks.deliveryContextFromSession
      .mockReturnValueOnce({
        channel: "matrix",
        accountId: "acct-thread",
        threadId: "$thread-event",
      })
      .mockReturnValueOnce({ channel: "matrix", to: "room:!MixedCase:example.org" });
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: true as const,
      to: "room:!MixedCase:example.org",
    });

    await wakeRestartSentinel();

    expectMockCallFields(mocks.resolveOutboundTarget, {
      channel: "matrix",
      to: "room:!MixedCase:example.org",
      accountId: "acct-thread",
    });
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      channel: "matrix",
      to: "room:!MixedCase:example.org",
      accountId: "acct-thread",
      threadId: "$thread-event",
    });
  });
});
