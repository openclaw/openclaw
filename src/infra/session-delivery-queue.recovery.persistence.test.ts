import { describe, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue-recovery.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
} from "./session-delivery-queue-storage.js";
import { SessionDeliveryDeadLetteredError } from "./session-delivery-queue.records.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

function rejectWrite(
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
  id: string,
  phase: "retry" | "settlement",
) {
  // A real trigger is visible to the worker's existing connection.
  db.exec(`CREATE TRIGGER main.reject_session_delivery_${phase}
    BEFORE UPDATE ON delivery_queue_entries
    WHEN OLD.queue_name = 'session' AND OLD.id = '${id.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic session delivery ${phase} write failure');
    END;`);
}

function recover(
  mode: "startup" | "targeted drain",
  options: Parameters<typeof recoverPendingSessionDeliveries>[0],
  id: string,
  logLabel: string,
) {
  return mode === "startup"
    ? recoverPendingSessionDeliveries(options)
    : drainPendingSessionDelivery({ ...options, id, logLabel });
}

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
          rejectWrite(db, id, "retry");
          throw new Error("session delivery interrupted");
        });
        const log = createInfoWarnErrorLogger();

        try {
          await expect(
            recover(mode, { deliver, queueContext, log }, id, "test rejected retry persistence"),
          ).rejects.toThrow("synthetic session delivery retry write failure");
        } finally {
          db.exec("DROP TRIGGER IF EXISTS main.reject_session_delivery_retry");
        }

        expect(deliver).toHaveBeenCalledTimes(1);
        const [pending] = await loadPendingSessionDeliveries(queueContext);
        expect(pending).toEqual(expect.objectContaining({ id, retryCount: 0 }));
        expect(pending?.lastAttemptAt).toBeUndefined();

        const retryDelivery = vi.fn(async () => undefined);
        await expect(
          recoverPendingSessionDeliveries({ deliver: retryDelivery, queueContext, log }),
        ).resolves.toMatchObject({ recovered: 1 });
        expect(retryDelivery).toHaveBeenCalledTimes(1);
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
      });
    },
  );

  it.each(["startup", "targeted drain"] as const)(
    "reports the terminal reason before a real SQLite settlement failure during %s recovery",
    async (mode) => {
      await withSessionDeliveryQueue(async (tempDir, queueContext) => {
        const id = await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "delivery requiring terminal settlement",
          },
          queueContext,
        );
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        });
        const deliver = vi.fn(async () => {
          rejectWrite(db, id, "settlement");
          throw new SessionDeliveryDeadLetteredError("ambiguous side effects");
        });
        const log = createInfoWarnErrorLogger();

        try {
          await expect(
            recover(mode, { deliver, queueContext, log }, id, "Session delivery"),
          ).resolves.toMatchObject(mode === "startup" ? { recovered: 0, failed: 0 } : { id });
        } finally {
          db.exec("DROP TRIGGER IF EXISTS main.reject_session_delivery_settlement");
        }

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(
          `Session delivery: dead-letter decision for entry ${id}: ambiguous side effects`,
        );
        const [pending] = await loadPendingSessionDeliveries(queueContext);
        expect(pending).toEqual(expect.objectContaining({ id, retryCount: 0 }));
        expect(pending?.settlementOutcome).toBeUndefined();
        expect(pending?.lastError).toBeUndefined();
      });
    },
  );
});
