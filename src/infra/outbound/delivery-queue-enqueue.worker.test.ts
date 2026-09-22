import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  captureDeliveryQueueStateContext,
  getDeliveryQueueEntryStatus,
} from "../delivery-queue-sqlite.js";
import { seedDeliveryQueueEntry } from "../delivery-queue-sqlite.test-support.js";
import { holdEnqueueReply } from "./delivery-queue-enqueue.worker.test-support.js";
import { createDeliveryQueueMediaRetention } from "./delivery-queue-media-staging.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";
import type { StableDeliveryPreparation } from "./delivery-queue-preparation.js";
import {
  enqueueDelivery,
  enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce,
} from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

const payload = { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "original" }] };

describe("outbound enqueue worker", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the event loop responsive under a held writer and captures JSON custody and state before yielding", async () => {
    const stateDir = fixtures.tmpDir();
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await enqueueDelivery(payload, stateDir);
    const reply = holdEnqueueReply();
    const channelData = {
      date: new Date("2026-09-01T00:00:00.000Z"),
      finite: Number.NaN,
      absent: undefined,
      callable: () => "process local",
      custom: {
        toJSON: () => {
          process.env.OPENCLAW_STATE_DIR = path.join(stateDir, "serializer-state");
          return { canonical: true };
        },
      },
      nested: { value: "before" },
    };
    const input = { ...payload, payloads: [{ text: "before", channelData }] };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    db.exec("BEGIN IMMEDIATE");
    let settled = false;
    const before = Date.now();
    const enqueue = enqueueDelivery(input).finally(() => {
      settled = true;
    });
    input.payloads[0]!.text = "after";
    channelData.nested.value = "after";
    const otherState = path.join(stateDir, "other-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", otherState);
    try {
      await Promise.race([
        reply.posted,
        enqueue.then(() => {
          throw new Error("Enqueue bypassed the held worker writer");
        }),
      ]);
      await setImmediate();
      expect(settled).toBe(false);
      db.exec("COMMIT");
      expect(await reply.held).toBe("created");
      reply.release();
      const id = await enqueue;
      const stored = readQueuedEntry(stateDir, id);
      expect(stored.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(stored.preparedBatch).toMatchObject({
        entries: [
          {
            payload: {
              text: "before",
              channelData: {
                date: "2026-09-01T00:00:00.000Z",
                finite: null,
                custom: { canonical: true },
                nested: { value: "before" },
              },
            },
          },
        ],
      });
      expect(JSON.stringify(stored)).not.toContain("callable");
      expect(JSON.stringify(stored)).not.toContain("absent");
      expect(reply.attempts()).toBe(1);
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      reply.release();
      await enqueue;
      reply.restore();
    }
  });

  it("admits a cold enqueue without host data SQL", async () => {
    const stateDir = fixtures.tmpDir();
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
    await closeOpenClawStateDatabaseAsync();
    const context = captureDeliveryQueueStateContext(stateDir);
    const sql = observeHostDataSql({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    let id: string;
    try {
      id = await enqueueDelivery(payload, undefined, undefined, context);
      expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      sql.restore();
    }
    expect(readQueuedEntry(stateDir, id!).to).toBe(payload.to);
  });

  it("preserves JSON rejection before worker dispatch", async () => {
    const reply = holdEnqueueReply();
    try {
      await expect(
        enqueueDelivery(
          { ...payload, payloads: [{ channelData: { invalid: 1n } }] },
          fixtures.tmpDir(),
        ),
      ).rejects.toThrow(/BigInt/);
      expect(reply.attempts()).toBe(0);
    } finally {
      reply.restore();
    }
  });

  it("keeps stages on conflicts and atomically consumes only a matching preparation", async () => {
    const stateDir = fixtures.tmpDir();
    const id = "enqueue-preparation";
    const stage = createDeliveryQueueMediaRetention([], "outbound-media-stage", stateDir);
    seedDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      stateDir,
      entry: { id: "legacy-owner", enqueuedAt: Date.now(), retryCount: 0 },
    });
    expect(await enqueueDeliveryOnce(payload, "legacy-owner", stateDir, stage)).toEqual({
      id: "legacy-owner",
      created: false,
    });
    expect(
      getDeliveryQueueEntryStatus(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stage, stateDir),
    ).toBe("pending");
    await expect(enqueueDeliveryOnce(payload, "missing-stage", stateDir, "absent")).rejects.toThrow(
      "media stage expired",
    );
    const preparation: StableDeliveryPreparation = {
      id,
      enqueuedAt: Date.now(),
      retryCount: 0,
      attemptCount: 0,
      preparationState: "prepared",
      preparationOwnerId: "owner",
      preparationLeaseExpiresAt: Date.now() + 60_000,
    };
    seedDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
      stateDir,
      entry: preparation,
    });
    await expect(
      enqueuePreparedDeliveryOnce(
        payload,
        id,
        { ...preparation, preparationOwnerId: "stale" },
        stateDir,
        stage,
      ),
    ).rejects.toThrow("preparation");
    expect(
      getDeliveryQueueEntryStatus(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stage, stateDir),
    ).toBe("pending");
    await expect(
      enqueuePreparedDeliveryOnce(payload, id, preparation, stateDir, "absent"),
    ).rejects.toThrow("media stage expired");
    const pending = enqueuePreparedDeliveryOnce(payload, id, preparation, stateDir, stage);
    preparation.preparationOwnerId = "changed-after-capture";
    expect(await pending).toEqual({ id, created: true });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, id, stateDir),
    ).toBeUndefined();
    expect(
      getDeliveryQueueEntryStatus(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stage, stateDir),
    ).toBeUndefined();
    expect(readQueuedEntry(stateDir, id).to).toBe(payload.to);
  });
});
