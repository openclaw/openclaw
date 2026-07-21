// Verifies SQLite-backed outbound queue storage, metadata, failure updates,
// recovery-state markers, and failed-entry moves.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  cancelDeliveryQueueMediaStage,
  createDeliveryQueueMediaStage,
} from "./delivery-queue-media-staging.js";
import {
  failPendingDelivery,
  getOutboundDeliveryQueueStatus,
  loadPendingDelivery,
  loadPendingDeliveries,
  moveToFailed,
  reserveDeliveryAttempt,
} from "./delivery-queue-storage.js";
import {
  ackDelivery,
  clearDeliveryMessageSentProviderAttempts,
  enqueueDelivery,
  enqueueDeliveryOnce,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  recordDeliveryMessageSentHookEvent,
} from "./delivery-queue.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const enqueueTextDelivery = (params: Parameters<typeof enqueueDelivery>[0], rootDir = tmpDir()) =>
    enqueueDelivery(params, rootDir);

  function readStatus(id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    const row = db
      .prepare(
        "SELECT status FROM delivery_queue_entries WHERE queue_name = 'outbound-v2' AND id = ?",
      )
      .get(id) as { status?: string } | undefined;
    return row?.status;
  }

  async function enqueueSpoolDelivery(suffix: string) {
    const artifact = path.join(
      tmpDir(),
      "delivery-queue-media",
      `00000000-0000-4000-8000-00000000000${suffix}.ogg`,
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "audio-bytes");
    const id = await enqueueTextDelivery({
      channel: "directchat",
      to: "+1",
      payloads: [{ mediaUrl: artifact, audioAsVoice: true }],
    });
    return { artifact, id };
  }

  describe("enqueue + ack lifecycle", () => {
    it("persists a producer-specific retry budget", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "retry-budget" }],
        maxRetries: 45,
      });

      expect(readQueuedEntry(tmpDir(), id).maxRetries).toBe(45);
    });

    it("atomically reserves delivery attempts up to the producer budget", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "attempt-budget" }],
        maxRetries: 2,
      });

      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 1,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 2,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "exhausted",
        attemptCount: 2,
      });
      expect(readQueuedEntry(tmpDir(), id).attemptCount).toBe(2);
    });

    it("creates and removes a queue entry", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "directchat",
          to: "+1555",
          queuePolicy: "required",
          requireUnknownSendReconciliation: true,
          durableDeliveryProtocol: "test-replay-v1",
          payloads: [{ text: "prepared hello" }],
          preparedHookPayloadIndexes: [0],
          payloadSourceIndexes: [1],
          messageSentHookMode: "logical_terminal",
          renderedBatchPlan: {
            payloadCount: 1,
            textCount: 1,
            mediaCount: 0,
            voiceCount: 0,
            presentationCount: 0,
            interactiveCount: 0,
            channelDataCount: 0,
            items: [{ index: 0, kinds: ["text"] as const, text: "hello", mediaUrls: [] }],
          },
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          gatewayClientScopes: ["operator.write"],
          preparedMessageId: "prepared-message-1",
          mirror: {
            sessionKey: "agent:main:main",
            expectedSessionId: "session-main",
            text: "hello",
            mediaUrls: ["https://example.com/file.png"],
            idempotencyKey: "channel-final:message-1",
            deliveryMirror: {
              kind: "channel-final",
              sourceMessageId: "message-1",
            },
          },
          session: {
            key: "agent:main:main",
            agentId: "agent-main",
            requesterAccountId: "acct-1",
            requesterSenderId: "sender-1",
          },
        },
        tmpDir(),
      );
      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.id).toBe(id);
      expect(entry.channel).toBe("directchat");
      expect(entry.to).toBe("+1555");
      expect(entry.queuePolicy).toBe("required");
      expect(entry.requireUnknownSendReconciliation).toBe(true);
      expect(entry.renderedBatchPlan).toEqual({
        payloadCount: 1,
        textCount: 1,
        mediaCount: 0,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [{ index: 0, kinds: ["text"] as const, text: "hello", mediaUrls: [] }],
      });
      expect(entry.bestEffort).toBe(true);
      expect(entry.gifPlayback).toBe(true);
      expect(entry.silent).toBe(true);
      expect(entry.gatewayClientScopes).toEqual(["operator.write"]);
      expect(entry.preparedMessageId).toBe("prepared-message-1");
      expect(entry.mirror).toEqual({
        sessionKey: "agent:main:main",
        expectedSessionId: "session-main",
        text: "hello",
        mediaUrls: ["https://example.com/file.png"],
        idempotencyKey: "channel-final:message-1",
        deliveryMirror: {
          kind: "channel-final",
          sourceMessageId: "message-1",
        },
      });
      expect(entry.session).toEqual({
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
      });
      expect(entry.retryCount).toBe(0);
      expect(entry.payloads).toEqual([{ text: "prepared hello" }]);
      expect(entry.preparedHookPayloadIndexes).toEqual([0]);
      expect(entry.durableDeliveryProtocol).toBe("test-replay-v1");
      expect(entry.payloadSourceIndexes).toEqual([1]);
      expect(entry.messageSentHookMode).toBe("logical_terminal");
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      const legacyCount = db
        .prepare(
          "SELECT count(*) AS count FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?",
        )
        .get(id) as { count: number };
      expect(legacyCount.count).toBe(0);

      await ackDelivery(id, tmpDir());
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    });

    it("does not replace an existing stable queue intent", async () => {
      const first = await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "first" }],
          deliveryCompletion: {
            kind: "conversation",
            agentId: "main",
            operationId: "operation-stable",
          },
        },
        "operation-stable",
        tmpDir(),
      );
      const repeated = await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "replacement" }],
        },
        "operation-stable",
        tmpDir(),
      );

      expect(first).toEqual({ id: "operation-stable", created: true });
      expect(repeated).toEqual({ id: "operation-stable", created: false });
      expect(readQueuedEntry(tmpDir(), "operation-stable")).toMatchObject({
        payloads: [{ text: "first" }],
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-stable",
        },
      });
    });

    it("does not duplicate a stable intent owned by the shipped queue namespace", async () => {
      await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "legacy owner" }],
        },
        "operation-upgrade-stable",
        tmpDir(),
      );
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET queue_name = 'outbound' WHERE queue_name = 'outbound-v2' AND id = ?",
      ).run("operation-upgrade-stable");

      const repeated = await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "replacement" }],
        },
        "operation-upgrade-stable",
        tmpDir(),
      );

      expect(repeated).toEqual({ id: "operation-upgrade-stable", created: false });
      expect(await loadPendingDelivery("operation-upgrade-stable", tmpDir())).toMatchObject({
        payloads: [{ text: "legacy owner" }],
      });
      const rows = db
        .prepare("SELECT queue_name FROM delivery_queue_entries WHERE id = ?")
        .all("operation-upgrade-stable") as Array<{ queue_name: string }>;
      expect(rows).toEqual([{ queue_name: "outbound" }]);
    });

    it("does not publish a staged stable intent over shipped queue ownership", async () => {
      await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "legacy staged owner" }],
        },
        "operation-upgrade-staged",
        tmpDir(),
      );
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET queue_name = 'outbound' WHERE queue_name = 'outbound-v2' AND id = ?",
      ).run("operation-upgrade-staged");
      const stageId = createDeliveryQueueMediaStage(["/tmp/staged-upgrade-media"], tmpDir());

      try {
        const repeated = await enqueueDeliveryOnce(
          {
            channel: "directchat",
            to: "+1555",
            payloads: [{ text: "replacement", mediaUrl: "/tmp/staged-upgrade-media" }],
          },
          "operation-upgrade-staged",
          tmpDir(),
          stageId,
        );

        expect(repeated).toEqual({ id: "operation-upgrade-staged", created: false });
        const rows = db
          .prepare("SELECT queue_name FROM delivery_queue_entries WHERE id = ?")
          .all("operation-upgrade-staged") as Array<{ queue_name: string }>;
        expect(rows).toEqual([{ queue_name: "outbound" }]);
      } finally {
        cancelDeliveryQueueMediaStage(stageId, tmpDir());
      }
    });

    it("keeps permanent completion ownership after ack", async () => {
      const id = "restart-sentinel-notice:agent:main:main:123";
      await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "restart complete" }],
          completionRetention: "permanent",
        },
        id,
        tmpDir(),
      );

      await ackDelivery(id, tmpDir());
      const repeated = await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "must not replay" }],
          completionRetention: "permanent",
        },
        id,
        tmpDir(),
      );

      expect(repeated).toEqual({ id, created: false });
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
      expect(readStatus(id)).toBe("completed");
    });

    it("reads and acknowledges legacy queue rows without exposing v2 rows to old readers", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1",
        payloads: [{ text: "legacy raw" }],
      });
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET queue_name = 'outbound' WHERE queue_name = 'outbound-v2' AND id = ?",
      ).run(id);

      await expect(loadPendingDelivery(id, tmpDir())).resolves.toMatchObject({
        id,
        payloads: [{ text: "legacy raw" }],
      });
      await ackDelivery(id, tmpDir());
      await expect(loadPendingDelivery(id, tmpDir())).resolves.toBeNull();
    });

    it("preserves enqueue order across legacy and v2 queue namespaces", async () => {
      const legacyId = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1",
        payloads: [{ text: "legacy first" }],
      });
      const v2Id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1",
        payloads: [{ text: "v2 second" }],
      });
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET queue_name = 'outbound' WHERE queue_name = 'outbound-v2' AND id = ?",
      ).run(legacyId);

      await expect(loadPendingDeliveries(tmpDir())).resolves.toMatchObject([
        { id: legacyId },
        { id: v2Id },
      ]);
    });

    it("ack is idempotent (no error on missing file)", async () => {
      await expect(ackDelivery("nonexistent-id", tmpDir())).resolves.toBeUndefined();
    });

    it("removes acked entries from pending recovery", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1",
        payloads: [{ text: "ack-test" }],
      });

      await ackDelivery(id, tmpDir());

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readStatus(id)).toBeUndefined();
    });
  });

  describe("failDelivery", () => {
    it("marks entries as send-attempt-started before platform I/O", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), {
        replyToId: "1782584644.377229",
      });

      const entry = readQueuedEntry(tmpDir(), id);
      expect(typeof entry.platformSendStartedAt).toBe("number");
      expect((entry.platformSendStartedAt as number) > 0).toBe(true);
      expect(entry.recoveryState).toBe("send_attempt_started");
      expect(entry.effectiveReplyToId).toBe("1782584644.377229");
      expect(entry.retryCount).toBe(0);
    });

    it("marks entries as unknown-after-send after platform I/O returns", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(typeof entry.platformSendStartedAt).toBe("number");
      expect((entry.platformSendStartedAt as number) > 0).toBe(true);
      expect(entry.recoveryState).toBe("unknown_after_send");
      expect(entry.retryCount).toBe(0);
    });

    it("refreshes the attempt timestamp immediately before provider I/O", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        vi.setSystemTime(9_000);
        await markDeliveryPlatformSendDispatched(id, tmpDir());
      } finally {
        vi.useRealTimers();
      }

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.platformSendStartedAt).toBe(9_000);
      expect(entry.recoveryState).toBe("send_attempt_started");
    });

    it("increments retryCount, records attempt time, and sets lastError", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await failDelivery(id, "connection refused", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(typeof entry.lastAttemptAt).toBe("number");
      expect((entry.lastAttemptAt as number) > 0).toBe(true);
      expect(entry.lastError).toBe("connection refused");
    });

    it("keeps post-send failure evidence while recording the retry failure", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
      });

      await failDeliveryAfterPlatformSend(id, "state update failed", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(entry.lastError).toBe("state update failed");
      expect(entry.recoveryState).toBe("unknown_after_send");
      expect(typeof entry.platformSendStartedAt).toBe("number");
    });

    it("atomically records a pre-send failure without retaining send evidence", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
      });
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), { payloadIndex: 0 });

      await failDeliveryBeforePlatformSend(id, "connect refused", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(entry.lastError).toBe("connect refused");
      expect(entry.recoveryState).toBeUndefined();
      expect(entry.platformSendStartedAt).toBeUndefined();
      expect(entry.messageSentProviderAttemptedPayloadIndexes).toBeUndefined();
    });

    it("clears only payload attempts proven not dispatched", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "first" }, { text: "second" }],
      });
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), { payloadIndex: 0 });
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), { payloadIndex: 1 });

      await clearDeliveryMessageSentProviderAttempts(id, [1], tmpDir());

      expect(readQueuedEntry(tmpDir(), id).messageSentProviderAttemptedPayloadIndexes).toEqual([0]);
    });

    it("atomically retains other payload attempts on a scoped pre-send failure", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "first" }, { text: "second" }],
      });
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), { payloadIndex: 0 });
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), { payloadIndex: 1 });

      await failDeliveryBeforePlatformSend(id, "second not dispatched", tmpDir(), [1]);

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.recoveryState).toBe("send_attempt_started");
      expect(entry.platformSendStartedAt).toEqual(expect.any(Number));
      expect(entry.messageSentProviderAttemptedPayloadIndexes).toEqual([0]);
    });

    it("retains intent ambiguity when another payload has finalized success evidence", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "first" }, { text: "second" }],
      });
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), { payloadIndex: 0 });
      await recordDeliveryMessageSentHookEvent(
        id,
        {
          payloadIndex: 0,
          event: { success: true, content: "first", messageId: "message-1" },
        },
        tmpDir(),
      );
      await clearDeliveryMessageSentProviderAttempts(id, [0], tmpDir());
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), { payloadIndex: 1 });

      await failDeliveryBeforePlatformSend(id, "second not dispatched", tmpDir(), [1]);

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.recoveryState).toBe("send_attempt_started");
      expect(entry.platformSendStartedAt).toEqual(expect.any(Number));
      expect(entry.messageSentProviderAttemptedPayloadIndexes).toBeUndefined();
      expect(entry.messageSentHookEvents).toEqual([
        {
          payloadIndex: 0,
          event: { success: true, content: "first", messageId: "message-1" },
        },
      ]);
    });

    it("persists provider-finalized success by payload and ignores retryable failure events", async () => {
      const id = await enqueueTextDelivery({
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
      });
      await recordDeliveryMessageSentHookEvent(
        id,
        {
          payloadIndex: 0,
          event: { success: true, content: "first", messageId: "event-1" },
        },
        tmpDir(),
      );
      await recordDeliveryMessageSentHookEvent(
        id,
        {
          payloadIndex: 1,
          event: { success: false, content: "second", error: "retryable" },
        },
        tmpDir(),
      );

      expect(readQueuedEntry(tmpDir(), id).messageSentHookEvents).toEqual([
        {
          payloadIndex: 0,
          event: { success: true, content: "first", messageId: "event-1" },
        },
      ]);
    });
  });

  describe("getOutboundDeliveryQueueStatus", () => {
    it("distinguishes active, terminal, and removed rows", async () => {
      const pending = await enqueueTextDelivery({
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "pending" }],
      });
      const terminal = await enqueueTextDelivery({
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "terminal" }],
      });
      const removed = await enqueueTextDelivery({
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "removed" }],
      });
      await moveToFailed(terminal, tmpDir());
      await ackDelivery(removed, tmpDir());

      expect(getOutboundDeliveryQueueStatus(pending, tmpDir())).toBe("pending");
      expect(getOutboundDeliveryQueueStatus(terminal, tmpDir())).toBe("terminal");
      expect(getOutboundDeliveryQueueStatus(removed, tmpDir())).toBe("absent");
    });
  });

  describe("failPendingDelivery", () => {
    it("atomically writes the failed status and immutable reason into row and entry JSON", async () => {
      const id = await enqueueTextDelivery({
        channel: "slack",
        to: "C123",
        accountId: "enterprise",
        payloads: [{ text: "blocked" }],
      });
      const entry = await loadPendingDelivery(id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }

      await expect(
        failPendingDelivery(
          {
            id,
            expectedStatus: "pending",
            lastError: "unsupported_enterprise_slack_delivery",
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "failed" });

      expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
      expect(readStatus(id)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), id).lastError).toBe("unsupported_enterprise_slack_delivery");
    });

    it("returns a typed no-op when a status race already moved the row", async () => {
      const id = await enqueueTextDelivery({
        channel: "slack",
        to: "C123",
        payloads: [{ text: "blocked" }],
      });
      const entry = await loadPendingDelivery(id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }
      await moveToFailed(id, tmpDir());

      await expect(
        failPendingDelivery(
          {
            id,
            expectedStatus: "pending",
            lastError: "unsupported_enterprise_slack_delivery",
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "not_pending" });
      expect(readQueuedEntry(tmpDir(), id).lastError).toBeUndefined();
    });
  });

  describe("moveToFailed", () => {
    it("moves entry to failed/ subdirectory", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readStatus(id)).toBe("failed");
    });

    it("does not remove failed entries when a stale ack arrives", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());
      await ackDelivery(id, tmpDir());

      expect(readStatus(id)).toBe("failed");
    });
  });

  describe("queue media custody", () => {
    it("can retain artifacts while an active recovery attempt owns them", async () => {
      const acked = await enqueueSpoolDelivery("0");

      await ackDelivery(acked.id, tmpDir(), { retainSpoolArtifacts: true });

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      await expect(fs.stat(acked.artifact)).resolves.toBeDefined();
    });

    it("releases artifacts after every terminal queue transition", async () => {
      const acked = await enqueueSpoolDelivery("1");
      await ackDelivery(acked.id, tmpDir());
      await expect(fs.stat(acked.artifact)).rejects.toThrow();

      const moved = await enqueueSpoolDelivery("2");
      await moveToFailed(moved.id, tmpDir());
      await expect(fs.stat(moved.artifact)).rejects.toThrow();

      const guarded = await enqueueSpoolDelivery("3");
      const entry = await loadPendingDelivery(guarded.id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }
      await failPendingDelivery(
        {
          id: guarded.id,
          expectedStatus: "pending",
          lastError: "terminal failure",
          entry,
        },
        tmpDir(),
      );
      await expect(fs.stat(guarded.artifact)).rejects.toThrow();
    });
  });

  describe("loadPendingDeliveries", () => {
    it("returns empty array for an empty state database", async () => {
      expect(await loadPendingDeliveries(path.join(tmpDir(), "no-such-dir"))).toStrictEqual([]);
    });

    it("loads multiple entries", async () => {
      await enqueueTextDelivery({ channel: "directchat", to: "+1", payloads: [{ text: "a" }] });
      await enqueueTextDelivery({ channel: "forum", to: "2", payloads: [{ text: "b" }] });

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
    });

    it("persists gateway caller scopes for replay", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "2",
          payloads: [{ text: "b" }],
          gatewayClientScopes: ["operator.write"],
        },
        tmpDir(),
      );

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.gatewayClientScopes).toEqual(["operator.write"]);
    });

    it("persists session context for recovery replay", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "2",
          payloads: [{ text: "b" }],
          session: {
            key: "agent:main:main",
            agentId: "agent-main",
            requesterAccountId: "acct-1",
            requesterSenderId: "sender-1",
            requesterSenderName: "Sender One",
            requesterSenderUsername: "sender.one",
            requesterSenderE164: "+15551234567",
          },
        },
        tmpDir(),
      );

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.session).toEqual({
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
        requesterSenderName: "Sender One",
        requesterSenderUsername: "sender.one",
        requesterSenderE164: "+15551234567",
      });
    });
  });
});
