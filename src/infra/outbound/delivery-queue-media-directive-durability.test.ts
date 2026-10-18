import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "../../channels/plugins/types.adapters.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { collectEntrySpoolPaths } from "./delivery-queue-media-spool.js";
import { drainPendingDeliveriesCore, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  loadPendingDeliveries,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

function installMatrixAdapter(outbound: ChannelOutboundAdapter): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
      },
    ]),
  );
}

function enqueuePhaseAdapter(mediaPaths: string[]): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async () => ({ channel: "matrix", messageId: "t" }),
    sendMedia: async (ctx: ChannelOutboundContext) => {
      mediaPaths.push(ctx.mediaUrl ?? "");
      throw new PlatformMessageNotDispatchedError("forced not-dispatched (test)", {
        cause: new Error("test"),
      });
    },
  };
}

type RecoveredSend = { mediaUrl: string; fromSpool: boolean; bytes: string };

function recoveryPhaseAdapter(records: RecoveredSend[], spoolRoot: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async () => ({ channel: "matrix", messageId: "t" }),
    sendMedia: async (ctx: ChannelOutboundContext) => {
      const mediaUrl = ctx.mediaUrl ?? "";
      const fromSpool = path.dirname(mediaUrl) === spoolRoot;
      const bytes = (await fs.readFile(mediaUrl)).toString("hex");
      records.push({ mediaUrl, fromSpool, bytes });
      return { channel: "matrix", messageId: "recovered" };
    },
  };
}

describe("delivery-queue MEDIA-directive durability (end-to-end)", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;
  let sourceDir: string;
  let spoolRoot: string;
  const to = "!room:example";
  const bytes = Buffer.from("durable media directive proof payload\n", "utf8");
  const send = (payloads: ReplyPayload[], skipQueue = false) =>
    deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to,
      payloads,
      ...(skipQueue ? { skipQueue: true } : { queuePolicy: "required" }),
      mediaAccess: { localRoots: [sourceDir] },
    });
  async function writeSource(name: string) {
    const source = path.join(sourceDir, name);
    await fs.writeFile(source, bytes);
    return source;
  }
  async function expectNoSpool() {
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    await expect(fs.readdir(spoolRoot)).rejects.toThrow();
  }

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(async () => {
    tmpDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    spoolRoot = path.join(tmpDir, "delivery-queue-media");
    sourceDir = await fs.realpath(await fs.mkdtemp(path.join(tmpDir, "src-")));
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("replays MEDIA-directive local media from a queue-owned copy after the source is deleted", async () => {
    const source = await writeSource("generated.txt");
    const payloads: ReplyPayload[] = [{ text: `caption\nMEDIA:${source}` }];
    const inputSnapshot = structuredClone(payloads);

    const liveMediaPaths: string[] = [];
    installMatrixAdapter(enqueuePhaseAdapter(liveMediaPaths));

    await expect(send(payloads)).rejects.toThrow("forced not-dispatched");
    expect(liveMediaPaths).toEqual([source]);
    expect(payloads).toEqual(inputSnapshot);

    const [entry] = await loadPendingDeliveries(tmpDir);
    expect(entry).toBeDefined();
    const queuedPayloads = entry
      ? acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload)
      : [];
    const spoolPaths = [...new Set(collectEntrySpoolPaths(queuedPayloads, tmpDir))];
    expect(spoolPaths).toHaveLength(1);
    expect(path.dirname(spoolPaths[0] ?? "")).toBe(spoolRoot);
    expect(queuedPayloads[0]?.text).toBe("caption");
    expect(await fs.readFile(spoolPaths[0] ?? "")).toEqual(bytes);

    await fs.rm(source, { force: true });
    await expect(fs.readFile(source)).rejects.toThrow();

    const recovered: RecoveredSend[] = [];
    installMatrixAdapter(recoveryPhaseAdapter(recovered, spoolRoot));
    const deliver = vi.fn<DeliverFn>(async (params) => deliverOutboundPayloads(params));
    await drainPendingDeliveriesCore({
      drainKey: "media-directive-test",
      logLabel: "media-directive drain",
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir,
      deliver,
      selectEntry: (e) => ({ match: e.channel === "matrix", bypassBackoff: true }),
    });

    expect(recovered).toMatchObject([
      {
        fromSpool: true,
        bytes: bytes.toString("hex"),
      },
    ]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.mediaUrl).not.toBe(source);
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });

  it("fails a required send closed for sensitive directive media (no row, no spool)", async () => {
    const source = await writeSource("secret.txt");
    installMatrixAdapter(enqueuePhaseAdapter([]));

    await expect(send([{ text: `MEDIA:${source}`, sensitiveMedia: true }])).rejects.toThrow(
      /cannot be persisted|unsupported/i,
    );

    await expectNoSpool();
  });

  it("does not spool directive media when the queue is skipped", async () => {
    const source = await writeSource("skip.txt");
    const liveMediaPaths: string[] = [];
    installMatrixAdapter({
      deliveryMode: "direct",
      sendText: async () => ({ channel: "matrix", messageId: "t" }),
      sendMedia: async (ctx: ChannelOutboundContext) => {
        liveMediaPaths.push(ctx.mediaUrl ?? "");
        return { channel: "matrix", messageId: "sent" };
      },
    });

    await send([{ text: `MEDIA:${source}` }], true);
    expect(liveMediaPaths).toEqual([source]);
    await expectNoSpool();
  });
});
