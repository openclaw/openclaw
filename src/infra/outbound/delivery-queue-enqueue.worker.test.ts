import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { outboundDeliveryNotifications } from "../delivery-queue-cache.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import {
  getDeliveryQueueEntryStatus,
  seedDeliveryQueueEntry,
} from "../delivery-queue-sqlite.test-support.js";
import { holdEnqueueReply } from "./delivery-queue-enqueue.worker.test-support.js";
import { createDeliveryQueueMediaRetention } from "./delivery-queue-media-staging.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME as MEDIA_STAGE_QUEUE,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME as LEGACY_QUEUE,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME as PREPARATION_QUEUE,
} from "./delivery-queue-namespaces.js";
import {
  enqueueDelivery,
  enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce,
} from "./delivery-queue-storage.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

const payload = { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "original" }] };

describe("outbound enqueue worker", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    outboundDeliveryNotifications.onEnqueued = () => {};
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const openState = (stateDir: string) =>
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
  const status = (queue: string, id: string) =>
    getDeliveryQueueEntryStatus(queue, id, fixtures.tmpDir());
  const seed = (queueName: string, entry: Parameters<typeof seedDeliveryQueueEntry>[0]["entry"]) =>
    seedDeliveryQueueEntry({ queueName, entry, stateDir: fixtures.tmpDir() });

  it("keeps the event loop responsive under a held writer and captures JSON custody and state before yielding", async () => {
    const stateDir = fixtures.tmpDir();
    const { db } = openState(stateDir);
    await enqueueDelivery(payload, stateDir);
    const enqueued = vi.fn();
    outboundDeliveryNotifications.onEnqueued = enqueued;
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
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(stateDir, "other-state"));
    try {
      await Promise.race([
        reply.posted,
        enqueue.then(() => {
          throw new Error("Enqueue bypassed the held worker writer");
        }),
      ]);
      await setImmediate();
      expect([settled, enqueued.mock.calls]).toEqual([false, []]);
      db.exec("COMMIT");
      expect(await reply.held).toBe("created");
      expect(enqueued).toHaveBeenCalledExactlyOnceWith(stateDir);
      reply.release();
      const id = await enqueue;
      const stored = readQueuedEntry(stateDir, id);
      expect(stored.enqueuedAt).toBeGreaterThanOrEqual(before);
      const serializedData = {
        date: "2026-09-01T00:00:00.000Z",
        finite: null,
        custom: { canonical: true },
        nested: { value: "before" },
      };
      expect(stored.preparedBatch).toMatchObject({
        entries: [{ payload: { text: "before", channelData: serializedData } }],
      });
      expect(JSON.stringify(stored)).not.toMatch(/callable|absent/);
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
    openState(stateDir);
    await closeOpenClawStateDatabaseAsync();
    const context = captureDeliveryQueueStateContext(stateDir);
    const sql = observeHostDataSql();
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
    const enqueued = vi.fn();
    outboundDeliveryNotifications.onEnqueued = enqueued;
    const id = "enqueue-preparation";
    const stage = await createDeliveryQueueMediaRetention([], "outbound-media-stage", stateDir);
    seed(LEGACY_QUEUE, { id: "legacy-owner", enqueuedAt: Date.now(), retryCount: 0 });
    expect(await enqueueDeliveryOnce(payload, "legacy-owner", stateDir, stage)).toEqual({
      id: "legacy-owner",
      created: false,
    });
    expect(status(MEDIA_STAGE_QUEUE, stage)).toBe("pending");
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
    seed(PREPARATION_QUEUE, preparation);
    const publish = (owner = preparation, mediaStage = stage) =>
      enqueuePreparedDeliveryOnce(payload, id, owner, stateDir, mediaStage);
    await expect(publish({ ...preparation, preparationOwnerId: "stale" })).rejects.toThrow(
      "preparation",
    );
    expect(status(MEDIA_STAGE_QUEUE, stage)).toBe("pending");
    await expect(publish(preparation, "absent")).rejects.toThrow("media stage expired");
    const pending = publish();
    preparation.preparationOwnerId = "changed-after-capture";
    expect(await pending).toEqual({ id, created: true });
    expect(enqueued).toHaveBeenLastCalledWith(stateDir);
    expect([status(PREPARATION_QUEUE, id), status(MEDIA_STAGE_QUEUE, stage)]).toEqual([
      undefined,
      undefined,
    ]);
    expect(readQueuedEntry(stateDir, id).to).toBe(payload.to);
  });
});
