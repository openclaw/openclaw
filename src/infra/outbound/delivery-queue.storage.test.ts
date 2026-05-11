import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  loadPendingDelivery,
  loadPendingDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
} from "./delivery-queue.js";
import {
  installDeliveryQueueTmpDirHooks,
  readFailedQueuedEntry,
  readQueuedEntryStorageFields,
  readPendingQueuedEntries,
  readQueuedEntry,
  writeQueuedEntryJsonForTest,
} from "./delivery-queue.test-helpers.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const enqueueTextDelivery = (params: Parameters<typeof enqueueDelivery>[0], rootDir = tmpDir()) =>
    enqueueDelivery(params, rootDir);

  describe("enqueue + ack lifecycle", () => {
    it("creates and removes a queue entry", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "hello" }],
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
          mirror: {
            sessionKey: "agent:main:main",
            text: "hello",
            mediaUrls: ["https://example.com/file.png"],
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

      expect(readPendingQueuedEntries(tmpDir()).map((entry) => entry.id)).toEqual([id]);

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.id).toBe(id);
      expect(entry.channel).toBe("directchat");
      expect(entry.to).toBe("+1555");
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
      expect(entry.mirror).toEqual({
        sessionKey: "agent:main:main",
        text: "hello",
        mediaUrls: ["https://example.com/file.png"],
      });
      expect(entry.session).toEqual({
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
      });
      expect(entry.retryCount).toBe(0);
      expect(entry.payloads).toEqual([{ text: "hello" }]);
      expect(readQueuedEntryStorageFields(tmpDir(), id)).toMatchObject({
        account_id: "acct-1",
        channel: "directchat",
        entry_kind: "outbound",
        last_attempt_at: null,
        last_error: null,
        platform_send_started_at: null,
        recovery_state: null,
        retry_count: 0,
        session_key: "agent:main:main",
        target: "+1555",
      });

      await ackDelivery(id, tmpDir());
      expect(readPendingQueuedEntries(tmpDir())).toHaveLength(0);
    });

    it("ack is idempotent (no error on missing file)", async () => {
      await expect(ackDelivery("nonexistent-id", tmpDir())).resolves.toBeUndefined();
    });

    it.each([
      {
        name: "ack removes a pending row so recovery does not replay",
        payload: { channel: "directchat", to: "+1", payloads: [{ text: "ack-test" }] },
        action: (id: string) => ackDelivery(id, tmpDir()),
      },
      {
        name: "loadPendingDeliveries ignores acked rows",
        payload: { channel: "forum", to: "99", payloads: [{ text: "stale" }] },
        action: async (id: string) => {
          await ackDelivery(id, tmpDir());
          return loadPendingDeliveries(tmpDir());
        },
        expectedEntriesLength: 0,
      },
    ])("$name", async ({ payload, action, expectedEntriesLength }) => {
      const id = await enqueueTextDelivery(payload);

      const entries = await action(id);

      if (expectedEntriesLength !== undefined) {
        expect(entries).toHaveLength(expectedEntriesLength);
      }
      expect(readPendingQueuedEntries(tmpDir())).toHaveLength(0);
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

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());

      const entry = await loadPendingDelivery(id, tmpDir());
      expect(typeof entry?.platformSendStartedAt).toBe("number");
      expect((entry?.platformSendStartedAt ?? 0) > 0).toBe(true);
      expect(entry).toMatchObject({
        recoveryState: "send_attempt_started",
        retryCount: 0,
      });
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

      const entry = await loadPendingDelivery(id, tmpDir());
      expect(typeof entry?.platformSendStartedAt).toBe("number");
      expect((entry?.platformSendStartedAt ?? 0) > 0).toBe(true);
      expect(entry).toMatchObject({
        recoveryState: "unknown_after_send",
        retryCount: 0,
      });
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

      const entry = await loadPendingDelivery(id, tmpDir());
      expect(entry?.retryCount).toBe(1);
      expect(typeof entry?.lastAttemptAt).toBe("number");
      expect((entry?.lastAttemptAt ?? 0) > 0).toBe(true);
      expect(entry?.lastError).toBe("connection refused");
      expect(readQueuedEntryStorageFields(tmpDir(), id)).toMatchObject({
        last_error: "connection refused",
        retry_count: 1,
      });
    });

    it("loads mutable queue state from typed columns instead of replay JSON", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          accountId: "acct-typed",
          payloads: [{ text: "test" }],
          session: {
            key: "agent:typed:main",
            agentId: "agent-main",
            requesterAccountId: "acct-session",
            requesterSenderId: "sender-1",
          },
        },
        tmpDir(),
      );
      const replayJson = readQueuedEntry(tmpDir(), id);
      writeQueuedEntryJsonForTest(tmpDir(), id, {
        ...replayJson,
        channel: "directchat",
        lastAttemptAt: 1,
        lastError: "json error",
        platformSendStartedAt: 2,
        recoveryState: "unknown_after_send",
        retryCount: 99,
        session: {
          ...((replayJson.session as Record<string, unknown> | undefined) ?? {}),
          key: "agent:json:main",
        },
        to: "json-target",
      });

      const entry = await loadPendingDelivery(id, tmpDir());

      expect(entry).toMatchObject({
        accountId: "acct-typed",
        channel: "forum",
        retryCount: 0,
        session: {
          key: "agent:typed:main",
          requesterAccountId: "acct-session",
        },
        to: "123",
      });
      expect(entry?.lastAttemptAt).toBeUndefined();
      expect(entry?.lastError).toBeUndefined();
      expect(entry?.platformSendStartedAt).toBeUndefined();
      expect(entry?.recoveryState).toBeUndefined();
    });
  });

  describe("moveToFailed", () => {
    it("moves entry to failed status", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());

      expect(readPendingQueuedEntries(tmpDir()).map((entry) => entry.id)).not.toContain(id);
      expect(readFailedQueuedEntry(tmpDir(), id)).toMatchObject({ id });
    });
  });

  describe("loadPendingDeliveries", () => {
    it("returns empty array when the SQLite queue is empty", async () => {
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
