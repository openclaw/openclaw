import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { recoverPendingSessionDeliveries } from "../session-delivery-queue-recovery.js";
import { enqueueSessionDelivery } from "../session-delivery-queue-storage.js";
import type { QueuedSessionDelivery } from "../session-delivery-queue.records.js";
import { migrateLegacyDeliveryQueues } from "../state-migrations.storage.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";
import { pruneOrphanedDeliveryQueueMedia } from "./delivery-queue-media-spool.js";
import { migrateLegacyPendingOutboundDeliveries } from "./delivery-queue-migration.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

const NOW = Date.UTC(2026, 8, 12, 12);
const AGE_LIMIT = 72 * 60 * 60_000;
const send = vi.fn(async (_text: string) => ({ messageId: "recorded-only" }));
const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ text }) => ({ channel: "matrix", ...(await send(text)) }),
};

describe("legacy file queue migration to recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  let queueContext: OpenClawStateWorkerContext;
  beforeEach(() => {
    queueContext = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    send.mockClear();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
        },
      ]),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });

  it("does not dispatch legacy files at or beyond 72 hours, but delivers fresh work once", async () => {
    const originals = new Map<string, Buffer>();
    for (const dirName of ["delivery-queue", "session-delivery-queue"]) {
      const dir = path.join(tmpDir(), dirName);
      fs.mkdirSync(dir, { recursive: true });
      for (const [id, age] of [
        ["below", AGE_LIMIT - 1],
        ["exact", AGE_LIMIT],
        ["above", AGE_LIMIT + 1],
      ] as const) {
        const entry = {
          id,
          enqueuedAt: NOW - age,
          retryCount: 0,
          ...(dirName === "delivery-queue"
            ? { channel: "matrix", to: "!room:example", payloads: [{ text: id }] }
            : { kind: "agentTurn", sessionKey: "agent:main:main", message: id, messageId: id }),
        };
        const sourcePath = path.join(dir, id + ".json");
        const bytes = Buffer.from(JSON.stringify(entry, null, 2) + "\n");
        originals.set(sourcePath, bytes);
        fs.writeFileSync(sourcePath, bytes);
      }
    }
    const migrated = await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    expect(migrated.warningDisposition).toBe("recoverable");
    expect(migrated.warnings).toHaveLength(4);
    for (const [sourcePath, bytes] of originals) {
      expect(fs.readFileSync(sourcePath + ".migrated")).toEqual(bytes);
      expect(fs.existsSync(sourcePath)).toBe(false);
    }
    const deliverSession = vi.fn(async (_entry: QueuedSessionDelivery) => undefined);
    for (let pass = 0; pass < 2; pass++) {
      await migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
      });
      await recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
        deliver: deliverOutboundPayloadsInternal,
      });
      await recoverPendingSessionDeliveries({
        queueContext,
        log: createRecoveryLog(),
        deliver: deliverSession,
      });
    }
    expect.soft(send.mock.calls.map(([text]) => text)).toEqual(["below"]);
    expect(
      deliverSession.mock.calls.map(([entry]) =>
        entry.kind === "systemEvent" ? entry.text : entry.message,
      ),
    ).toEqual(["below"]);
  });
  it.each(["outbound", "session"])(
    "%s: preserves held queue-owned attachments after normal spool cleanup",
    async (queueName) => {
      const spool = path.join(tmpDir(), "delivery-queue-media");
      fs.mkdirSync(spool, { recursive: true });
      const name = "12345678-1234-4234-8234-123456789abc.png";
      const media = path.join(spool, name);
      const bytes = Buffer.from([0, 255, 128, 4, 9]);
      fs.writeFileSync(media, bytes);
      fs.utimesSync(media, new Date(NOW - 4 * 86400000), new Date(NOW - 4 * 86400000));
      const queue = path.join(
        tmpDir(),
        queueName === "outbound" ? "delivery-queue" : "session-delivery-queue",
      );
      fs.mkdirSync(queue, { recursive: true });
      const source = path.join(queue, "held.json");
      const raw = JSON.stringify({
        id: "held",
        enqueuedAt: NOW - AGE_LIMIT,
        retryCount: 0,
        ...(queueName === "outbound"
          ? {
              channel: "matrix",
              to: "!room:example",
              payloads: [{ text: "held", mediaUrl: media }],
            }
          : {
              kind: "agentTurn",
              sessionKey: "agent:main:main",
              message: "held",
              messageId: "held",
              expectedMediaUrls: [media],
            }),
      });
      fs.writeFileSync(source, raw);
      await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
      await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir(), nowMs: NOW });
      expect(fs.existsSync(media)).toBe(false);
      expect(fs.readFileSync(source + ".migrated", "utf8")).toBe(raw);
      const archive = source + ".media.migrated";
      const copies = fs.readdirSync(archive);
      expect(copies).toHaveLength(1);
      expect(fs.readFileSync(path.join(archive, copies[0]!))).toEqual(bytes);
    },
  );
  it("keeps ordinary old SQLite deliveries eligible, without adding a runtime TTL", async () => {
    vi.mocked(Date.now).mockReturnValue(NOW - 2 * AGE_LIMIT);
    await enqueueDelivery(
      { channel: "matrix", to: "!room:example", payloads: [{ text: "normal-old" }] },
      tmpDir(),
    );
    await enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "normal-old",
        messageId: "normal-old",
      },
      queueContext,
    );
    vi.mocked(Date.now).mockReturnValue(NOW);
    await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    const session = vi.fn(async (_entry: QueuedSessionDelivery) => undefined);
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
      deliver: deliverOutboundPayloadsInternal,
    });
    await recoverPendingSessionDeliveries({
      queueContext,
      log: createRecoveryLog(),
      deliver: session,
    });
    expect(send.mock.calls.map(([text]) => text)).toEqual(["normal-old"]);
    expect(session).toHaveBeenCalledTimes(1);
  });

  it("does not redeliver a consumed row when source archival is retried", async () => {
    const dir = path.join(tmpDir(), "delivery-queue");
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, "once.json");
    const bytes = JSON.stringify({
      id: "once",
      enqueuedAt: NOW - 1,
      retryCount: 0,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "once" }],
    });
    fs.writeFileSync(source, bytes);
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (from === source) {
        throw new Error("injected archive failure");
      }
      return rename(from, to);
    });
    await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    await migrateLegacyPendingOutboundDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
    });
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
      deliver: deliverOutboundPayloadsInternal,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(source)).toBe(true);
    failure.mockRestore();
    await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    await migrateLegacyPendingOutboundDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
    });
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
      deliver: deliverOutboundPayloadsInternal,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(source + ".migrated", "utf8")).toBe(bytes);
  });
  it.each(["outbound", "session"])(
    "%s: preserves media through failed copies, terminal rows, and archive retries",
    async (queueName) => {
      const spool = path.join(tmpDir(), "delivery-queue-media");
      fs.mkdirSync(spool, { recursive: true });
      const name = "23456789-1234-4234-8234-123456789abc.png";
      const media = path.join(spool, name);
      const bytes = Buffer.from([255, 0, 7, 128]);
      const queue = path.join(
        tmpDir(),
        queueName === "outbound" ? "delivery-queue" : "session-delivery-queue",
      );
      fs.mkdirSync(path.join(queue, "failed"), { recursive: true });
      for (const variant of ["copy-failure", "failed", "archive-failure"] as const) {
        fs.writeFileSync(media, bytes);
        fs.utimesSync(media, new Date(NOW - 4 * 86400000), new Date(NOW - 4 * 86400000));
        const source = path.join(
          queue,
          variant === "failed" ? "failed/terminal.json" : variant + ".json",
        );
        const raw = JSON.stringify({
          id: variant,
          enqueuedAt: NOW - AGE_LIMIT,
          retryCount: 1,
          retainOnFailure: true,
          ...(queueName === "outbound"
            ? { channel: "matrix", to: "!room:example", payloads: [{ mediaUrl: media }] }
            : {
                kind: "agentTurn",
                sessionKey: "agent:main:main",
                message: "held",
                messageId: variant,
                expectedMediaUrls: [media],
              }),
        });
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, raw);
        const archive = source + ".media.migrated";
        if (variant === "copy-failure") {
          fs.writeFileSync(archive, "injected obstruction");
        }
        const rename = fs.renameSync;
        const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (variant === "archive-failure" && from === source) {
            throw new Error("injected archive failure");
          }
          return rename(from, to);
        });
        await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
        await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir(), nowMs: NOW });
        fault.mockRestore();
        if (variant === "copy-failure") {
          expect.soft(fs.existsSync(media)).toBe(true);
          fs.rmSync(archive);
        } else {
          expect.soft(fs.existsSync(media)).toBe(false);
        }
        await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
        expect.soft(fs.existsSync(source)).toBe(false);
        expect.soft(fs.existsSync(source + ".migrated")).toBe(true);
        if (fs.existsSync(archive) && fs.statSync(archive).isDirectory()) {
          const copies = fs.readdirSync(archive);
          expect.soft(copies).toHaveLength(1);
          expect.soft(fs.readFileSync(path.join(archive, copies[0]!))).toEqual(bytes);
        } else {
          expect.soft(false, "verified media backup is missing").toBe(true);
        }
      }
    },
  );
  it.each(["outbound", "session"])(
    "%s: reacquires media custody when an archived source reappears",
    async (queueName) => {
      const spool = path.join(tmpDir(), "delivery-queue-media");
      fs.mkdirSync(spool, { recursive: true });
      const media = path.join(spool, "34567890-1234-4234-8234-123456789abc.png");
      fs.writeFileSync(media, Buffer.from([0, 255, 2]));
      fs.utimesSync(media, new Date(NOW - 4 * 86400000), new Date(NOW - 4 * 86400000));
      const queue = path.join(
        tmpDir(),
        queueName === "outbound" ? "delivery-queue" : "session-delivery-queue",
      );
      fs.mkdirSync(queue, { recursive: true });
      const source = path.join(queue, "reappeared.json");
      const raw = JSON.stringify({
        id: "reappeared",
        enqueuedAt: NOW - AGE_LIMIT,
        retryCount: 0,
        ...(queueName === "outbound"
          ? { channel: "matrix", to: "!room:example", payloads: [{ mediaUrl: media }] }
          : {
              kind: "agentTurn",
              sessionKey: "agent:main:main",
              message: "held",
              messageId: "reappeared",
              expectedMediaUrls: [media],
            }),
      });
      fs.writeFileSync(source, raw);
      await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
      expect(fs.existsSync(source)).toBe(false);
      fs.writeFileSync(source, raw);
      const backupDir = source + ".media.migrated";
      for (const name of fs.readdirSync(backupDir)) {
        fs.rmSync(path.join(backupDir, name));
      }
      const retried = await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
      expect(retried.warnings.length).toBeGreaterThan(0);
      await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir(), nowMs: NOW });
      expect(fs.existsSync(media)).toBe(true);
      expect(fs.readFileSync(source, "utf8")).toBe(raw);
    },
  );
});
