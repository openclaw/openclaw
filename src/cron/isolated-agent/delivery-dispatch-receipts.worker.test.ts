import { afterEach, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { seedDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-namespaces.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  isCompletedDirectCronDelivery,
  waitForDirectCronDeliveryOwner,
} from "./delivery-dispatch-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it.each([OUTBOUND_DELIVERY_QUEUE_NAME, "outbound-session-generation-v1"])(
  "selects cron receipts in %s without caller SQL",
  async (queueName) => {
    const stateDir = tempDirs.make("cron-receipt-worker-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const now = Date.now();
    const retention = { idPrefix: "cron-receipt:", maxAgeMs: 60_000, maxEntries: 10 };
    for (const [name, status, enqueuedAt, recoveryState] of [
      ["completed", "completed", now, "completed_bounded"],
      ["expired", "completed", now - 120_000, "completed_bounded"],
      ["abandoned", "pending", now, "send_attempt_started"],
      ["unsent", "pending", now, undefined],
    ] as const) {
      seedDeliveryQueueEntry({
        queueName,
        stateDir,
        status,
        entry: {
          id: `${retention.idPrefix}${name}`,
          enqueuedAt,
          retryCount: 0,
          recoveryState,
          completionRetention: retention,
          platformSendStartedAt: now - 60_000,
        },
      });
    }
    const observer = observeParentSqlite();
    try {
      expect(await isCompletedDirectCronDelivery("cron-receipt:completed", queueName)).toBe(true);
      expect(await isCompletedDirectCronDelivery("cron-receipt:expired", queueName)).toBe(false);
      expect(
        await waitForDirectCronDeliveryOwner({ id: "cron-receipt:completed", queueName }),
      ).toBe("completed");
      expect(
        await waitForDirectCronDeliveryOwner({ id: "cron-receipt:abandoned", queueName }),
      ).toBe("unknown");
      expect(await waitForDirectCronDeliveryOwner({ id: "cron-receipt:unsent", queueName })).toBe(
        "unsent",
      );
      expect(await waitForDirectCronDeliveryOwner({ id: "cron-receipt:missing", queueName })).toBe(
        "unknown",
      );
      expect(observer.counts).toEqual(emptySqliteCounts());
    } finally {
      observer.restore();
    }
  },
);
