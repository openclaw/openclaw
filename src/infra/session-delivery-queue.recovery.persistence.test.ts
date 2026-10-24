import { expect, it, vi } from "vitest";
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

it.each([
  { mode: "startup", phase: "retry" },
  { mode: "targeted drain", phase: "retry" },
  { mode: "startup", phase: "settlement" },
  { mode: "targeted drain", phase: "settlement" },
] as const)("preserves $phase failures during $mode recovery", async ({ mode, phase }) => {
  await withSessionDeliveryQueue(async (tempDir, queueContext) => {
    const terminal = phase === "settlement";
    const id = await enqueueSessionDelivery(
      {
        kind: "systemEvent",
        sessionKey: "agent:main:main",
        text: terminal
          ? "delivery requiring terminal settlement"
          : "recover after retry writes are allowed",
      },
      queueContext,
    );
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    const deliver = vi.fn(async () => {
      rejectWrite(db, id, phase);
      throw terminal
        ? new SessionDeliveryDeadLetteredError("ambiguous side effects")
        : new Error("session delivery interrupted");
    });
    const log = createInfoWarnErrorLogger();
    try {
      const recovery = recover(
        mode,
        { deliver, queueContext, log },
        id,
        terminal ? "Session delivery" : "test rejected retry persistence",
      );
      if (terminal) {
        await expect(recovery).resolves.toMatchObject(
          mode === "startup" ? { recovered: 0, failed: 0 } : { id },
        );
      } else {
        await expect(recovery).rejects.toThrow("synthetic session delivery retry write failure");
      }
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS main.reject_session_delivery_${phase}`);
    }
    expect(deliver).toHaveBeenCalledTimes(1);
    const [pending] = await loadPendingSessionDeliveries(queueContext);
    expect(pending).toMatchObject({ id, retryCount: 0 });
    if (terminal) {
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        `Session delivery: dead-letter decision for entry ${id}: ambiguous side effects`,
      );
      expect([pending?.settlementOutcome, pending?.lastError]).toEqual([undefined, undefined]);
    } else {
      expect(pending?.lastAttemptAt).toBeUndefined();
      const retryDelivery = vi.fn(async () => undefined);
      await expect(
        recoverPendingSessionDeliveries({ deliver: retryDelivery, queueContext, log }),
      ).resolves.toMatchObject({ recovered: 1 });
      expect(retryDelivery).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    }
  });
});
