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

type QueueName = "outbound" | "session";

function legacyEntry(queueName: QueueName, id: string, age: number, media?: string) {
  return {
    id,
    enqueuedAt: NOW - age,
    retryCount: 0,
    ...(queueName === "outbound"
      ? { channel: "matrix", to: "!room:example", payloads: [{ text: id, mediaUrl: media }] }
      : {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: id,
          messageId: id,
          ...(media ? { expectedMediaUrls: [media] } : {}),
        }),
  };
}

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

  function writeLegacy(queueName: QueueName, name: string, entry: object) {
    const source = path.join(
      tmpDir(),
      queueName === "outbound" ? "delivery-queue" : "session-delivery-queue",
      name,
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const raw = JSON.stringify(entry, null, 2) + "\n";
    fs.writeFileSync(source, raw);
    return { source, raw };
  }

  function createMedia() {
    const media = path.join(
      tmpDir(),
      "delivery-queue-media",
      "23456789-1234-4234-8234-123456789abc.png",
    );
    const bytes = Buffer.from([255, 0, 7, 128]);
    fs.mkdirSync(path.dirname(media), { recursive: true });
    fs.writeFileSync(media, bytes);
    fs.utimesSync(media, new Date(NOW - 4 * 86400000), new Date(NOW - 4 * 86400000));
    return { media, bytes };
  }

  const recoverOutbound = () =>
    recoverPendingDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
      deliver: deliverOutboundPayloadsInternal,
    });

  it("does not dispatch legacy files at or beyond 72 hours, but delivers fresh work once", async () => {
    const originals = new Map<string, Buffer>();
    for (const queueName of ["outbound", "session"] as const) {
      for (const [id, age] of [
        ["below", AGE_LIMIT - 1],
        ["exact", AGE_LIMIT],
        ["above", AGE_LIMIT + 1],
      ] as const) {
        const { source, raw } = writeLegacy(
          queueName,
          id + ".json",
          legacyEntry(queueName, id, age),
        );
        originals.set(source, Buffer.from(raw));
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
      await recoverOutbound();
      await recoverPendingSessionDeliveries({
        queueContext,
        log: createRecoveryLog(),
        deliver: deliverSession,
      });
    }
    expect.soft(send.mock.calls.map(([text]) => text)).toEqual(["below"]);
    expect(
      deliverSession.mock.calls.map(([entry]) =>
        entry.kind === "agentTurn" ? entry.message : entry.text,
      ),
    ).toEqual(["below"]);
  });
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
    await recoverOutbound();
    await recoverPendingSessionDeliveries({
      queueContext,
      log: createRecoveryLog(),
      deliver: session,
    });
    expect(send.mock.calls.map(([text]) => text)).toEqual(["normal-old"]);
    expect(session).toHaveBeenCalledTimes(1);
  });

  it("does not redeliver a consumed row when source archival is retried", async () => {
    const { source, raw } = writeLegacy(
      "outbound",
      "once.json",
      legacyEntry("outbound", "once", 1),
    );
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
    await recoverOutbound();
    expect(send).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(source)).toBe(true);
    failure.mockRestore();
    await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    await migrateLegacyPendingOutboundDeliveries({
      cfg: {},
      stateDir: tmpDir(),
      log: createRecoveryLog(),
    });
    await recoverOutbound();
    expect(send).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(source + ".migrated", "utf8")).toBe(raw);
  });
  it("preserves outbound media through failed copies, terminal rows, and archive retries", async () => {
    for (const variant of ["copy-failure", "failed", "archive-failure"] as const) {
      const { media, bytes } = createMedia();
      const { source, raw } = writeLegacy(
        "outbound",
        variant === "failed" ? "failed/terminal.json" : variant + ".json",
        {
          ...legacyEntry("outbound", variant, AGE_LIMIT, media),
          retryCount: 1,
          retainOnFailure: true,
        },
      );
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
      expect.soft(fs.readFileSync(source + ".migrated", "utf8")).toBe(raw);
      if (fs.existsSync(archive) && fs.statSync(archive).isDirectory()) {
        const copies = fs.readdirSync(archive);
        expect.soft(copies).toHaveLength(1);
        expect.soft(fs.readFileSync(path.join(archive, copies[0]!))).toEqual(bytes);
      } else {
        expect.soft(false, "verified media backup is missing").toBe(true);
      }
    }
  });
  it("reacquires session media custody when an archived source reappears", async () => {
    const { media, bytes } = createMedia();
    const { source, raw } = writeLegacy(
      "session",
      "reappeared.json",
      legacyEntry("session", "reappeared", AGE_LIMIT, media),
    );
    await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    expect(fs.existsSync(source)).toBe(false);
    fs.writeFileSync(source, raw);
    const backupDir = source + ".media.migrated";
    const copies = fs.readdirSync(backupDir);
    expect(copies).toHaveLength(1);
    for (const name of copies) {
      expect(fs.readFileSync(path.join(backupDir, name))).toEqual(bytes);
      fs.rmSync(path.join(backupDir, name));
    }
    const retried = await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    expect(retried.warnings.length).toBeGreaterThan(0);
    await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir(), nowMs: NOW });
    expect(fs.existsSync(media)).toBe(true);
    expect(fs.readFileSync(source, "utf8")).toBe(raw);
  });
});
