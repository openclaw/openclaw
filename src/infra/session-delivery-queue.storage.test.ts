// Covers session delivery queue persistence state transitions.
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  advanceSessionDeliveryAgentRun,
  completeSessionDelivery,
  deferSessionDelivery,
  enqueueClaimedSessionDelivery,
  enqueueSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  mergeSessionDeliveryPreparedMediaBlocks,
  moveSessionDeliveryToFailed,
  releaseSessionDeliveryClaim,
} from "./session-delivery-queue-storage.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

describe("session-delivery queue storage", () => {
  async function settleSessionDelivery(
    id: string,
    queueContext: OpenClawStateWorkerContext,
  ): Promise<void> {
    const entry = await loadPendingSessionDelivery(id, queueContext);
    if (!entry) {
      throw new Error(`Expected pending session delivery ${id}`);
    }
    await markSessionDeliverySettlement(entry, "recovered", queueContext);
    await completeSessionDelivery(id, queueContext);
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

  it("dedupes entries when an idempotency key is reused", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const firstId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          idempotencyKey: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        queueContext,
      );
      const secondId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          idempotencyKey: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        queueContext,
      );

      expect(secondId).toBe(firstId);
      expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(1);
    });
  });

  it("grants one initial-attempt lease and releases it for recovery", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-lease:agent-loop",
        idempotencyKey: "image:task-lease:agent-loop",
      };
      const first = await enqueueClaimedSessionDelivery(payload, 60_000, queueContext);
      const duplicate = await enqueueClaimedSessionDelivery(payload, 60_000, queueContext);

      expect(first.claimed).toBe(true);
      expect(duplicate).toEqual({ id: first.id, claimed: false, status: "pending" });
      expect((await loadPendingSessionDeliveries(queueContext))[0]?.availableAt).toBeGreaterThan(
        Date.now(),
      );

      await releaseSessionDeliveryClaim(first.id, queueContext);
      expect(
        (await loadPendingSessionDeliveries(queueContext))[0]?.availableAt,
      ).toBeLessThanOrEqual(Date.now());
    });
  });

  it("reports a dead-letter conflict instead of claiming it as pending", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-dead-letter:agent-loop",
        idempotencyKey: "image:task-dead-letter:agent-loop",
      };
      const first = await enqueueClaimedSessionDelivery(payload, 60_000, queueContext);
      await moveSessionDeliveryToFailed(first.id, queueContext);

      await expect(enqueueClaimedSessionDelivery(payload, 60_000, queueContext)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status: "failed",
      });
    });
  });

  it("lets an explicit enqueue replace a deleted ordinary failure", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:revive-failed",
      };
      const id = await enqueueSessionDelivery(payload, queueContext);
      await moveSessionDeliveryToFailed(id, queueContext);

      expect(await enqueueSessionDelivery(payload, queueContext)).toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("pending");
      expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(1);
    });
  });

  it("never revives a failed permanent producer intent", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:permanent-failed",
        completionRetention: "permanent" as const,
      };
      const id = await enqueueSessionDelivery(payload, queueContext);
      await moveSessionDeliveryToFailed(id, queueContext);

      expect(await enqueueSessionDelivery(payload, queueContext)).toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("failed");
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("reports a completed conflict after acknowledgement", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-completed:agent-loop",
        idempotencyKey: "image:task-completed:agent-loop",
      };
      const first = await enqueueClaimedSessionDelivery(payload, 60_000, queueContext);
      await settleSessionDelivery(first.id, queueContext);

      expect(await enqueueSessionDelivery(payload, queueContext)).toBe(first.id);
      expect(readSessionQueueStatus(tempDir, first.id)).toBe("completed");

      await expect(enqueueClaimedSessionDelivery(payload, 60_000, queueContext)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status: "completed",
      });
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
      expect(readSessionQueueStatus(tempDir, first.id)).toBe("completed");
    });
  });

  it("persists retry metadata and retains acked idempotency tombstones", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        queueContext,
      );

      await failSessionDelivery(id, "dispatch failed", queueContext);
      const [failedEntry] = await loadPendingSessionDeliveries(queueContext);
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastError).toBe("dispatch failed");

      await settleSessionDelivery(id, queueContext);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
      expect(readSessionQueueStatus(tempDir, id)).toBe("completed");
    });
  });

  it("retains ambiguous attempt ownership and clears it only for a safe retry", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-attempt-owner:agent-loop",
        },
        queueContext,
      );
      const entry = await loadPendingSessionDelivery(id, queueContext);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }

      await markSessionDeliveryAttemptStarted(entry, queueContext);
      expect(await loadPendingSessionDelivery(id, queueContext)).toMatchObject({
        deliveryStartedAt: expect.any(Number),
      });

      await failSessionDelivery(id, "ambiguous failure after send", queueContext);
      expect(await loadPendingSessionDelivery(id, queueContext)).toMatchObject({
        deliveryStartedAt: expect.any(Number),
      });

      await failSessionDelivery(id, "safe failure before commit", queueContext, {
        releaseAttemptOwnership: true,
      });
      expect(await loadPendingSessionDelivery(id, queueContext)).not.toHaveProperty(
        "deliveryStartedAt",
      );
    });
  });

  it("records which agent run attempt consumed retry budget", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-charge:agent-loop",
        },
        queueContext,
      );

      await failSessionDelivery(id, "delivery failed", queueContext);
      expect(await loadPendingSessionDelivery(id, queueContext)).toMatchObject({
        retryCount: 1,
        lastChargedAgentRunAttempt: 0,
      });

      await advanceSessionDeliveryAgentRun(id, undefined, queueContext);
      await failSessionDelivery(id, "fresh delivery failed", queueContext);
      expect(await loadPendingSessionDelivery(id, queueContext)).toMatchObject({
        retryCount: 2,
        agentRunAttempt: 1,
        lastChargedAgentRunAttempt: 1,
      });
    });
  });

  it("persists agent-loop routing and provenance for restart replay", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:discord:channel:123",
          message: "generated image ready",
          messageId: "image:task-1:agent-loop",
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
        },
        queueContext,
      );

      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({
          route: expect.objectContaining({ channel: "discord", to: "channel:123" }),
          inputProvenance: expect.objectContaining({ sourceTool: "image_generate" }),
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        }),
      ]);
    });
  });

  it("advances only the agent run attempt and can focus its retry media", async () => {
    // Keep the one-time SQLite capability check outside the queue observation window.
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    const sqlCalls = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    try {
      await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
        const id = await enqueueSessionDelivery(
          {
            kind: "agentTurn",
            sessionKey: "agent:main:main",
            message: "all generated media",
            messageId: "image:task-retry:agent-loop",
            expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
            expectedMediaAttachments: {
              "/tmp/one.png": { type: "image", path: "/tmp/one.png", mimeType: "image/png" },
              "/tmp/two.png": { type: "image", path: "/tmp/two.png", mimeType: "image/png" },
            },
          },
          queueContext,
        );

        await failSessionDelivery(id, "ambiguous timeout", queueContext);
        await deferSessionDelivery(id, 1_000, queueContext);
        let [entry] = await loadPendingSessionDeliveries(queueContext);
        expect(entry).toMatchObject({ retryCount: 1 });
        expect(entry?.agentRunAttempt).toBeUndefined();
        expect(entry?.availableAt).toBeGreaterThan(Date.now());

        await mergeSessionDeliveryPreparedMediaBlocks(
          id,
          "/tmp/one.png",
          [{ type: "image", artifactId: "artifact-one" }],
          queueContext,
        );
        await expect(
          mergeSessionDeliveryPreparedMediaBlocks(
            id,
            "/tmp/one.png",
            [{ type: "image", artifactId: "replacement-must-not-win" }],
            queueContext,
          ),
        ).resolves.toEqual([{ type: "image", artifactId: "artifact-one" }]);
        await mergeSessionDeliveryPreparedMediaBlocks(
          id,
          "/tmp/two.png",
          [{ type: "image", artifactId: "artifact-two" }],
          queueContext,
        );

        await advanceSessionDeliveryAgentRun(
          id,
          {
            message: "only missing media",
            expectedMediaUrls: ["/tmp/two.png"],
            suppressTextDelivery: true,
          },
          queueContext,
        );
        [entry] = await loadPendingSessionDeliveries(queueContext);
        expect(entry).toMatchObject({
          agentRunAttempt: 1,
          retryCount: 1,
          message: "only missing media",
          expectedMediaUrls: ["/tmp/two.png"],
          expectedMediaAttachments: {
            "/tmp/one.png": { type: "image", path: "/tmp/one.png", mimeType: "image/png" },
            "/tmp/two.png": { type: "image", path: "/tmp/two.png", mimeType: "image/png" },
          },
          preparedMediaBlocks: {
            "/tmp/one.png": [{ type: "image", artifactId: "artifact-one" }],
            "/tmp/two.png": [{ type: "image", artifactId: "artifact-two" }],
          },
          suppressTextDelivery: true,
        });
      });
      for (const call of sqlCalls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      for (const call of sqlCalls) {
        call.mockRestore();
      }
    }
  });

  it("moves entries into completed idempotency state", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        queueContext,
      );

      await settleSessionDelivery(id, queueContext);

      expect(readSessionQueueStatus(tempDir, id)).toBe("completed");
    });
  });

  it("retains a permanent completion receipt", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:permanent-completed",
        completionRetention: "permanent" as const,
      };
      const id = await enqueueSessionDelivery(payload, queueContext);
      await settleSessionDelivery(id, queueContext);

      expect(await enqueueSessionDelivery(payload, queueContext)).toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("completed");
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });
});
