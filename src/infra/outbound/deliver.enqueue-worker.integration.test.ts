import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type {
  ChannelMessageSendMediaContext,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { loadDeliveryQueueEntries } from "../delivery-queue-sqlite.js";
import { isDeliveryRecoveryOwnedRetry } from "../delivery-recovery.shared.js";
import { sqliteWorkerPreloadEnv } from "../sqlite-worker-preload.test-support.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
} from "../state-database-coordinator.js";
import * as queueAdmission from "./deliver-queue-admission.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { holdEnqueueReply } from "./delivery-queue-enqueue.worker.test-support.js";
import { DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import { StableDeliveryPreparationLostError } from "./delivery-queue-preparation.js";
import { ackDelivery, enqueueDelivery } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";
import { createStructuredOutboundPayloadPlan } from "./payloads.js";
import {
  acceptedPreparedOutboundEntries,
  createUnmodifiedPreparedOutboundBatch,
} from "./prepared-batch.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;
let deliverStructuredOutboundPayloadsInternal: typeof import("./deliver.js").deliverStructuredOutboundPayloadsInternal;

describe("enqueue publication custody through the real sender", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  beforeAll(async () => {
    ({ deliverOutboundPayloads, deliverStructuredOutboundPayloadsInternal } =
      await import("./deliver.js"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function deliver(
    mode: "raw" | "prepared",
    params: Parameters<typeof deliverOutboundPayloads>[0],
  ) {
    if (mode === "raw") {
      return deliverOutboundPayloads(params);
    }
    const { payloads, ...delivery } = params;
    return deliverStructuredOutboundPayloadsInternal({
      ...delivery,
      plan: createStructuredOutboundPayloadPlan(payloads),
    });
  }

  async function source() {
    const stateDir = fixtures.tmpDir();
    const mediaUrl = path.join(stateDir, "synthetic.txt");
    await fs.writeFile(mediaUrl, "synthetic retained media");
    return { stateDir, mediaUrl };
  }

  function installSender() {
    const send = vi.fn(
      async (context: ChannelMessageSendMediaContext | ChannelMessageSendTextContext) => {
        await context.onPlatformSendDispatch?.();
        const isMedia = "mediaUrl" in context;
        if (isMedia) {
          expect(await fs.readFile(context.mediaUrl, "utf8")).toBe("synthetic retained media");
        } else {
          expect(context.text).toBe("synthetic retained text");
        }
        return {
          messageId: "synthetic-delivered",
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "matrix", messageId: "synthetic-delivered" }],
            kind: isMedia ? "media" : "text",
          }),
        };
      },
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
            message: {
              id: "matrix",
              durableFinal: { capabilities: { text: true, media: true } },
              send: { text: send, media: send },
            },
          },
        },
      ]),
    );
    return send;
  }

  it.each(["raw", "prepared"] as const)(
    "retains media after a committed reply is lost, suppresses live fallback, and recovers exactly once (%s)",
    async (mode) => {
      const { stateDir, mediaUrl } = await source();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const send = installSender();
      const terminals: string[] = [];
      const unsubscribe = onTrustedMessageAuditEvent((event) => {
        if (event.action === "message.outbound.finished") {
          terminals.push(event.outcome);
        }
      });
      try {
        const reply = holdEnqueueReply();
        const delivery = deliver(mode, {
          cfg: {},
          channel: "matrix",
          to: "!synthetic:example",
          payloads: [{ mediaUrl }],
          mediaAccess: { localRoots: [stateDir] },
          queuePolicy: "best_effort",
        });
        const outcome = delivery.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          expect(
            await Promise.race([
              reply.held,
              outcome.then((settled) => {
                throw new Error("Delivery settled before committed reply", { cause: settled });
              }),
            ]),
          ).toBe("created");
          await reply.lose();
          const settled = await outcome;
          expect("error" in settled && isDeliveryRecoveryOwnedRetry(settled.error)).toBe(true);
          expect(send).not.toHaveBeenCalled();
          expect(terminals).toEqual([]);
          expect(reply.attempts()).toBe(1);
        } finally {
          reply.release();
          await outcome;
          reply.restore();
        }
        const [entry] = await loadPendingDeliveries(stateDir);
        expect(entry).toBeDefined();
        const artifact = acceptedPreparedOutboundEntries(entry!.preparedBatch)[0]!.payload
          .mediaUrl!;
        expect(artifact).not.toBe(mediaUrl);
        expect(await fs.readFile(artifact, "utf8")).toBe("synthetic retained media");
        expect(loadDeliveryQueueEntries(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stateDir)).toEqual(
          [],
        );
        await fs.unlink(mediaUrl);
        // Simulate lease expiry after the interrupted producer, without waiting for wall time.
        setQueuedEntryState(stateDir, entry!.id, { retryCount: 0, availableAt: 1 });
        await drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
        await drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
        expect(send).toHaveBeenCalledOnce();
        expect(await loadPendingDeliveries(stateDir)).toEqual([]);
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
        expect(terminals).toEqual(["sent"]);
      } finally {
        unsubscribe();
      }
    },
  );

  it("releases staged media after a known serialization failure and still permits best-effort delivery", async () => {
    const { stateDir, mediaUrl } = await source();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const send = installSender();
    const reply = holdEnqueueReply();
    const identity = {
      name: "synthetic",
      toJSON() {
        throw new Error("known JSON preparation failure");
      },
    };
    try {
      await deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ mediaUrl }],
        mediaAccess: { localRoots: [stateDir] },
        queuePolicy: "best_effort",
        identity,
      });
      expect(send).toHaveBeenCalledOnce();
      expect(reply.attempts()).toBe(0);
      expect(await loadPendingDeliveries(stateDir)).toEqual([]);
      expect(loadDeliveryQueueEntries(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stateDir)).toEqual(
        [],
      );
      expect(await fs.readdir(path.join(stateDir, "delivery-queue-media"))).toEqual([]);
    } finally {
      reply.restore();
    }
  });

  it.each(["media", "text"] as const)(
    "cleans a fully rolled-back native enqueue and preserves best-effort live sending (%s)",
    async (kind) => {
      const { stateDir, mediaUrl } = await source();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(path.join(stateDir, "delivery-queue-media"), { recursive: true });
      const databasePath = openOpenClawStateDatabase().path;
      const armPath = path.join(stateDir, "arm-rollback");
      const preloadPath = path.join(stateDir, "enqueue-rollback.cjs");
      await fs.writeFile(
        preloadPath,
        `
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const fs = require("node:fs");
  const { DatabaseSync } = require("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  let installed = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (sql.startsWith('insert into "delivery_queue_entries"')) {
      const database = this;
      const run = statement.run;
      statement.run = function(...args) {
        if (!installed && fs.realpathSync(database.location()) === fs.realpathSync(${JSON.stringify(databasePath)}) && fs.existsSync(${JSON.stringify(armPath)})) {
          installed = true;
          Reflect.apply(exec, database, ["CREATE TEMP TRIGGER reject_synthetic_enqueue BEFORE INSERT ON delivery_queue_entries WHEN NEW.queue_name = 'outbound-prepared-v1' BEGIN SELECT RAISE(ABORT, 'synthetic enqueue transaction rejected'); END"]);
        }
        return Reflect.apply(run, this, args);
      };
    }
    return statement;
  };
}
`,
      );
      for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preloadPath))) {
        vi.stubEnv(key, value);
      }
      const warmId = await enqueueDelivery(
        { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "warm" }] },
        stateDir,
      );
      await ackDelivery(warmId, stateDir);
      await fs.writeFile(armPath, "armed");
      const send = installSender();
      const queued = vi.fn();
      const reply = holdEnqueueReply();
      const admit = queueAdmission.stageAndEnqueueOutboundDelivery;
      let admissionFailure: unknown;
      vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery").mockImplementation(
        async (...args) => {
          try {
            return await admit(...args);
          } catch (error) {
            admissionFailure = error;
            throw error;
          }
        },
      );
      try {
        await deliverOutboundPayloads({
          cfg: {},
          channel: "matrix",
          to: "!synthetic:example",
          payloads: kind === "media" ? [{ mediaUrl }] : [{ text: "synthetic retained text" }],
          mediaAccess: { localRoots: [stateDir] },
          queuePolicy: "best_effort",
          onDeliveryIntent: queued,
        });
        expect(admissionFailure).toMatchObject({
          message: "synthetic enqueue transaction rejected",
        });
        expect(reply.attempts()).toBe(1);
        expect(send).toHaveBeenCalledOnce();
        expect(queued).not.toHaveBeenCalled();
        expect(await loadPendingDeliveries(stateDir)).toEqual([]);
        expect(loadDeliveryQueueEntries(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stateDir)).toEqual(
          [],
        );
        expect(await fs.readdir(path.join(stateDir, "delivery-queue-media"))).toEqual([]);
      } finally {
        reply.restore();
      }
    },
  );

  it("preserves a committed enqueue result when native coordinator cleanup then fails", async () => {
    const { stateDir, mediaUrl } = await source();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const databasePath = openOpenClawStateDatabase().path;
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath,
      runtimeDirectory: captureStateDatabaseCoordinatorRuntime().directory,
      uid: process.getuid?.(),
    });
    const armPath = path.join(stateDir, "arm-cleanup");
    const failedPath = path.join(stateDir, "cleanup-failed");
    const preloadPath = path.join(stateDir, "enqueue-cleanup.cjs");
    await fs.writeFile(
      preloadPath,
      `
const { isMainThread, parentPort } = require("node:worker_threads");
if (!isMainThread) {
  const fs = require("node:fs");
  const { deserialize } = require("node:v8");
  const { DatabaseSync } = require("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let enqueueRequest = false;
  let committed = false;
  let injected = false;
  let failedDatabase;
  parentPort.on("message", (request) => {
    enqueueRequest = request?.type === "execute" &&
      request.input instanceof Uint8Array &&
      deserialize(request.input)?.type === "deliveryQueue.enqueue";
    committed = false;
  });
  DatabaseSync.prototype.exec = function(sql) {
    if (enqueueRequest && committed && !injected && sql === "ROLLBACK" && fs.realpathSync(this.location()) === fs.realpathSync(${JSON.stringify(coordinatorPath)})) {
      injected = true;
      failedDatabase = this;
      fs.writeFileSync(${JSON.stringify(failedPath)}, "after commit");
      throw new Error("Synthetic enqueue coordinator rollback failure");
    }
    const result = Reflect.apply(exec, this, [sql]);
    if (enqueueRequest && sql === "COMMIT" && fs.existsSync(${JSON.stringify(armPath)}) && fs.realpathSync(this.location()) === fs.realpathSync(${JSON.stringify(databasePath)})) {
      fs.unlinkSync(${JSON.stringify(armPath)});
      committed = true;
    }
    return result;
  };
  DatabaseSync.prototype.close = function(...args) {
    if (this === failedDatabase) {
      failedDatabase = undefined;
      throw new Error("Synthetic enqueue coordinator close failure");
    }
    return Reflect.apply(close, this, args);
  };
}
`,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preloadPath))) {
      vi.stubEnv(key, value);
    }
    const warmId = await enqueueDelivery(
      { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "warm" }] },
      stateDir,
    );
    await ackDelivery(warmId, stateDir);
    await fs.writeFile(armPath, "armed");
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const send = installSender();
    const queued = vi.fn();
    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!synthetic:example",
      payloads: [{ mediaUrl }],
      mediaAccess: { localRoots: [stateDir] },
      queuePolicy: "best_effort",
      onDeliveryIntent: queued,
    });
    expect(await fs.readFile(failedPath, "utf8")).toBe("after commit");
    expect(warnings).toHaveBeenCalled();
    expect(queued).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
  });

  it.each(["raw", "prepared"] as const)(
    "does not resume a lost preparation when independent cleanup errors wrap it (%s)",
    async (mode) => {
      const { stateDir, mediaUrl } = await source();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const send = installSender();
      const primary = new StableDeliveryPreparationLostError("synthetic-preparation");
      const cleanup = new Error("synthetic media cleanup failure");
      const failure = new AggregateError([primary, cleanup], "admission and cleanup failed", {
        cause: cleanup,
      });
      vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery").mockRejectedValueOnce(failure);
      await expect(
        deliver(mode, {
          cfg: {},
          channel: "matrix",
          to: "!synthetic:example",
          payloads: [{ mediaUrl }],
          mediaAccess: { localRoots: [stateDir] },
          queuePolicy: "best_effort",
        }),
      ).rejects.toBe(failure);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("releases a staged copy on a known preparation refusal", async () => {
    const { stateDir, mediaUrl } = await source();
    const payloads = [{ mediaUrl }];
    await expect(
      queueAdmission.stageAndEnqueueOutboundDelivery(
        {
          cfg: {},
          channel: "matrix",
          to: "!synthetic:example",
          payloads,
          deliveryIntentId: "refused-preparation",
          deliveryQueueStateDir: stateDir,
          mediaAccess: { localRoots: [stateDir] },
        },
        createUnmodifiedPreparedOutboundBatch(payloads),
        {
          getStablePreparation: async () => {
            throw new Error("preparation owner closed");
          },
        },
      ),
    ).rejects.toThrow("preparation owner closed");
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
    expect(loadDeliveryQueueEntries(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stateDir)).toEqual([]);
    expect(await fs.readdir(path.join(stateDir, "delivery-queue-media"))).toEqual([]);
  });
});
