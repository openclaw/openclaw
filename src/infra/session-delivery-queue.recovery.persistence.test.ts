// Covers real session-delivery retry failures against the persistent SQLite queue.
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue-recovery.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
} from "./session-delivery-queue-storage.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

describe("session-delivery recovery persistence", () => {
  it.each(["startup", "targeted drain"] as const)(
    "surfaces real SQLite retry-persistence failures during %s recovery",
    async (mode) => {
      await withSessionDeliveryQueue(async (tempDir, queueContext) => {
        const id = await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "recover after retry writes are allowed",
          },
          queueContext,
        );
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        });
        const deliver = vi.fn(async () => {
          // An ordinary schema trigger is visible to the worker's existing connection.
          db.exec(`
            CREATE TRIGGER main.reject_session_delivery_retry
            BEFORE UPDATE ON delivery_queue_entries
            WHEN OLD.queue_name = 'session' AND OLD.id = '${id.replaceAll("'", "''")}'
            BEGIN
              SELECT RAISE(ABORT, 'synthetic session delivery retry write failure');
            END;
          `);
          throw new Error("session delivery interrupted");
        });
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        try {
          const recovery =
            mode === "startup"
              ? recoverPendingSessionDeliveries({ deliver, queueContext, log })
              : drainPendingSessionDelivery({
                  id,
                  logLabel: "test rejected retry persistence",
                  deliver,
                  queueContext,
                  log,
                });

          await expect(recovery).rejects.toThrow("synthetic session delivery retry write failure");
        } finally {
          db.exec("DROP TRIGGER IF EXISTS main.reject_session_delivery_retry");
        }

        expect(deliver).toHaveBeenCalledTimes(1);
        const [pending] = await loadPendingSessionDeliveries(queueContext);
        expect(pending).toEqual(expect.objectContaining({ id, retryCount: 0 }));
        expect(pending?.lastAttemptAt).toBeUndefined();

        const retryDelivery = vi.fn(async () => undefined);
        await expect(
          recoverPendingSessionDeliveries({
            deliver: retryDelivery,
            queueContext,
            log,
          }),
        ).resolves.toMatchObject({ recovered: 1 });
        expect(retryDelivery).toHaveBeenCalledTimes(1);
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
      });
    },
  );
});
