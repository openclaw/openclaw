import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  completeSessionDelivery as complete,
  deferSessionDelivery as defer,
  enqueueClaimedSessionDelivery as enqueueClaimed,
  enqueueSessionDelivery as enqueue,
  failSessionDelivery as fail,
  loadPendingSessionDelivery as loadPending,
  loadPendingSessionDeliveries as listPending,
  markSessionDeliverySettlement as markSettlement,
  mergeSessionDeliveryPreparedMediaBlocks as mergePrepared,
  moveSessionDeliveryToFailed as moveToFailed,
  releaseSessionDeliveryClaim as releaseClaim,
} from "./session-delivery-queue-storage.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

type Delivery = Parameters<typeof enqueue>[0];
function agentTurn(
  messageId: string,
  overrides: Partial<Extract<Delivery, { kind: "agentTurn" }>> = {},
): Extract<Delivery, { kind: "agentTurn" }> {
  return {
    kind: "agentTurn",
    sessionKey: "agent:main:main",
    message: "generated image ready",
    messageId,
    ...overrides,
  };
}
function systemEvent(idempotencyKey: string, permanent = false): Delivery {
  return {
    kind: "systemEvent",
    sessionKey: "agent:main:main",
    text: "restart complete",
    idempotencyKey,
    ...(permanent ? { completionRetention: "permanent" } : {}),
  };
}
const mediaAttachments = {
  "/tmp/one.png": { type: "image" as const, path: "/tmp/one.png", mimeType: "image/png" },
  "/tmp/two.png": { type: "image" as const, path: "/tmp/two.png", mimeType: "image/png" },
};
const imageBlocks = (artifactId: string) => [{ type: "image" as const, artifactId }];

describe("session-delivery queue storage", () => {
  async function settleSessionDelivery(
    id: string,
    queueContext: OpenClawStateWorkerContext,
  ): Promise<void> {
    const entry = await loadPending(id, queueContext);
    if (!entry) {
      throw new Error(`Expected pending session delivery ${id}`);
    }
    await markSettlement(entry, "recovered", queueContext);
    await complete(id, queueContext);
  }

  function readSessionQueueStatus(tempDir: string, id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    const row = db
      .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?")
      .get(id) as { status?: string } | undefined;
    return row?.status;
  }

  it("grants one initial-attempt lease and releases it for recovery", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const payload = agentTurn("image:task-lease:agent-loop", {
        idempotencyKey: "image:task-lease:agent-loop",
      });
      const first = await enqueueClaimed(payload, 60_000, queueContext);
      const duplicate = await enqueueClaimed(payload, 60_000, queueContext);

      expect(first.claimed).toBe(true);
      expect(duplicate).toEqual({ id: first.id, claimed: false, status: "pending" });
      expect((await listPending(queueContext))[0]?.availableAt).toBeGreaterThan(Date.now());

      await releaseClaim(first.id, queueContext);
      expect((await listPending(queueContext))[0]?.availableAt).toBeLessThanOrEqual(Date.now());
    });
  });

  it("reports a dead-letter conflict instead of claiming it as pending", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const payload = agentTurn("image:task-dead-letter:agent-loop", {
        idempotencyKey: "image:task-dead-letter:agent-loop",
      });
      const first = await enqueueClaimed(payload, 60_000, queueContext);
      await moveToFailed(first.id, queueContext);

      await expect(enqueueClaimed(payload, 60_000, queueContext)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status: "failed",
      });
    });
  });

  it.each([false, true])(
    "revives a failure only without permanent retention: %s",
    async (permanent) => {
      await withSessionDeliveryQueue(async (tempDir, queueContext) => {
        const payload = systemEvent("restart:failed", permanent);
        const id = await enqueue(payload, queueContext);
        await moveToFailed(id, queueContext);
        expect(await enqueue(payload, queueContext)).toBe(id);
        expect(readSessionQueueStatus(tempDir, id)).toBe(permanent ? "failed" : "pending");
        const pending = await listPending(queueContext);
        if (permanent) {
          expect(pending).toEqual([]);
        } else {
          expect(pending).toHaveLength(1);
        }
      });
    },
  );

  it("reports a completed conflict after acknowledgement", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const payload = agentTurn("image:task-completed:agent-loop", {
        idempotencyKey: "image:task-completed:agent-loop",
      });
      const first = await enqueueClaimed(payload, 60_000, queueContext);
      await settleSessionDelivery(first.id, queueContext);

      expect(await enqueue(payload, queueContext)).toBe(first.id);
      expect(readSessionQueueStatus(tempDir, first.id)).toBe("completed");

      await expect(enqueueClaimed(payload, 60_000, queueContext)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status: "completed",
      });
      expect(await listPending(queueContext)).toEqual([]);
      expect(readSessionQueueStatus(tempDir, first.id)).toBe("completed");
    });
  });

  it("persists agent-loop routing and provenance for restart replay", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueue(
        agentTurn("image:task-1:agent-loop", {
          sessionKey: "agent:main:discord:channel:123",
          route: {
            channel: "discord",
            to: "channel:123",
            accountId: "default",
            chatType: "channel",
          },
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "image_generate:task-1",
            sourceChannel: "internal",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        }),
        queueContext,
      );

      expect(await listPending(queueContext)).toEqual([
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:123",
          route: {
            channel: "discord",
            to: "channel:123",
            accountId: "default",
            chatType: "channel",
          },
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "image_generate:task-1",
            sourceChannel: "internal",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        }),
      ]);
    });
  });

  it("preserves prepared media through delivery retries", async () => {
    // Keep the one-time SQLite capability check outside the queue observation window.
    requireNodeSqlite();
    const sqlCalls = observeMainThreadSql();
    try {
      await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
        const id = await enqueue(
          agentTurn("image:task-retry:agent-loop", {
            message: "all generated media",
            expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
            expectedMediaAttachments: mediaAttachments,
          }),
          queueContext,
        );

        await fail(id, "ambiguous timeout", queueContext);
        await defer(id, 1_000, queueContext);
        const [entry] = await listPending(queueContext);
        expect(entry).toMatchObject({ retryCount: 1 });
        expect(entry?.agentRunAttempt).toBeUndefined();
        expect(entry?.availableAt).toBeGreaterThan(Date.now());

        await mergePrepared(id, "/tmp/one.png", imageBlocks("artifact-one"), queueContext);
        await expect(
          mergePrepared(id, "/tmp/one.png", imageBlocks("replacement-must-not-win"), queueContext),
        ).resolves.toEqual(imageBlocks("artifact-one"));
        await mergePrepared(id, "/tmp/two.png", imageBlocks("artifact-two"), queueContext);

        expect(await loadPending(id, queueContext)).toMatchObject({
          retryCount: 1,
          message: "all generated media",
          expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
          expectedMediaAttachments: mediaAttachments,
          preparedMediaBlocks: {
            "/tmp/one.png": imageBlocks("artifact-one"),
            "/tmp/two.png": imageBlocks("artifact-two"),
          },
        });
        await fail(id, "fresh delivery failed", queueContext);
        expect(await loadPending(id, queueContext)).toMatchObject({
          retryCount: 2,
        });
      });
      sqlCalls.expectIdle();
    } finally {
      sqlCalls.restore();
    }
  });

  it("retains a permanent completion receipt", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const payload = systemEvent("restart:permanent-completed", true);
      const id = await enqueue(payload, queueContext);
      await settleSessionDelivery(id, queueContext);

      expect(await enqueue(payload, queueContext)).toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("completed");
      expect(await listPending(queueContext)).toEqual([]);
    });
  });
});
