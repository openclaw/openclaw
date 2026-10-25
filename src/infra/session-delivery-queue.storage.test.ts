import { describe, expect, it } from "vitest";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { getDeliveryQueueEntryStatus } from "./delivery-queue-sqlite.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  advanceSessionDeliveryAgentRun as advanceRun,
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
const claimedPayload = (id: string) => agentTurn(id, { idempotencyKey: id });
const mediaAttachments = {
  "/tmp/one.png": { type: "image" as const, path: "/tmp/one.png", mimeType: "image/png" },
  "/tmp/two.png": { type: "image" as const, path: "/tmp/two.png", mimeType: "image/png" },
};
const imageBlocks = (artifactId: string) => [{ type: "image" as const, artifactId }];

describe("session-delivery queue storage", () => {
  async function settle(id: string, ctx: OpenClawStateWorkerContext): Promise<void> {
    const entry = await loadPending(id, ctx);
    if (!entry) {
      throw new Error(`Expected pending session delivery ${id}`);
    }
    await markSettlement(entry, "recovered", ctx);
    await complete(id, ctx);
  }

  const readStatus = (dir: string, id: string) => getDeliveryQueueEntryStatus("session", id, dir);

  it("grants one initial-attempt lease and releases it for recovery", async () => {
    await withSessionDeliveryQueue(async (_stateDir, ctx) => {
      const payload = claimedPayload("image:task-lease:agent-loop");
      const first = await enqueueClaimed(payload, 60_000, ctx);
      const duplicate = await enqueueClaimed(payload, 60_000, ctx);

      expect(first.claimed).toBe(true);
      expect(duplicate).toEqual({ id: first.id, claimed: false, status: "pending" });
      expect((await listPending(ctx))[0]?.availableAt).toBeGreaterThan(Date.now());

      await releaseClaim(first.id, ctx);
      expect((await listPending(ctx))[0]?.availableAt).toBeLessThanOrEqual(Date.now());
    });
  });

  it.each([false, true])(
    "revives a failure only without permanent retention: %s",
    async (permanent) => {
      await withSessionDeliveryQueue(async (dir, ctx) => {
        const payload = systemEvent("restart:failed", permanent);
        const id = await enqueue(payload, ctx);
        await moveToFailed(id, ctx);
        expect(await enqueue(payload, ctx)).toBe(id);
        expect(readStatus(dir, id)).toBe(permanent ? "failed" : "pending");
        const pending = await listPending(ctx);
        if (permanent) {
          expect(pending).toEqual([]);
        } else {
          expect(pending).toHaveLength(1);
        }
      });
    },
  );

  it.each(["failed", "completed"] as const)("reports a %s claim conflict", async (status) => {
    await withSessionDeliveryQueue(async (dir, ctx) => {
      const payload = claimedPayload(`image:${status}:agent-loop`);
      const first = await enqueueClaimed(payload, 60_000, ctx);
      if (status === "failed") {
        await moveToFailed(first.id, ctx);
      } else {
        await settle(first.id, ctx);
        expect(await enqueue(payload, ctx)).toBe(first.id);
      }

      await expect(enqueueClaimed(payload, 60_000, ctx)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status,
      });
      expect(await listPending(ctx)).toEqual([]);
      expect(readStatus(dir, first.id)).toBe(status);
    });
  });

  it("persists agent-loop routing and provenance for restart replay", async () => {
    await withSessionDeliveryQueue(async (_stateDir, ctx) => {
      const replay: Parameters<typeof agentTurn>[1] = {
        sessionKey: "agent:main:discord:channel:123",
        route: { channel: "discord", to: "channel:123", accountId: "default", chatType: "channel" },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "image_generate:task-1",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
      };
      await enqueue(agentTurn("image:task-1:agent-loop", replay), ctx);
      expect(await listPending(ctx)).toEqual([expect.objectContaining(replay)]);
    });
  });

  it("advances only the agent run attempt and can focus its retry media", async () => {
    // Keep the one-time SQLite capability check outside the queue observation window.
    requireNodeSqlite();
    const sqlCalls = observeMainThreadSql();
    try {
      await withSessionDeliveryQueue(async (_stateDir, ctx) => {
        const id = await enqueue(
          agentTurn("image:task-retry:agent-loop", {
            message: "all generated media",
            expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
            expectedMediaAttachments: mediaAttachments,
          }),
          ctx,
        );

        await fail(id, "ambiguous timeout", ctx);
        await defer(id, 1_000, ctx);
        let [entry] = await listPending(ctx);
        expect(entry).toMatchObject({ retryCount: 1 });
        expect(entry?.agentRunAttempt).toBeUndefined();
        expect(entry?.availableAt).toBeGreaterThan(Date.now());

        await mergePrepared(id, "/tmp/one.png", imageBlocks("artifact-one"), ctx);
        await expect(
          mergePrepared(id, "/tmp/one.png", imageBlocks("replacement-must-not-win"), ctx),
        ).resolves.toEqual(imageBlocks("artifact-one"));
        await mergePrepared(id, "/tmp/two.png", imageBlocks("artifact-two"), ctx);

        const retry = { message: "only missing media", expectedMediaUrls: ["/tmp/two.png"] };
        await advanceRun(id, retry, ctx);
        [entry] = await listPending(ctx);
        expect(entry).toMatchObject({
          agentRunAttempt: 1,
          retryCount: 1,
          ...retry,
          expectedMediaAttachments: mediaAttachments,
          preparedMediaBlocks: {
            "/tmp/one.png": imageBlocks("artifact-one"),
            "/tmp/two.png": imageBlocks("artifact-two"),
          },
        });
        await fail(id, "fresh delivery failed", ctx);
        expect(await loadPending(id, ctx)).toMatchObject({
          retryCount: 2,
          agentRunAttempt: 1,
          lastChargedAgentRunAttempt: 1,
        });
      });
      sqlCalls.expectIdle();
    } finally {
      sqlCalls.restore();
    }
  });
});
