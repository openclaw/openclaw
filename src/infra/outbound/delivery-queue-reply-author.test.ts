import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ackDelivery,
  enqueueDelivery,
  loadPendingDeliveries,
  recoverPendingDeliveries,
} from "./delivery-queue.js";

describe("delivery-queue replyToAuthor persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oc-queue-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists replyToAuthor and replays it on recovery", async () => {
    const id = await enqueueDelivery(
      {
        channel: "signal",
        to: "+1555",
        payloads: [{ text: "quoted reply" }],
        replyToId: "1771479242643",
        replyToAuthor: "6545fc21-4b79-40b7-9b4e-c8fc6f570e59",
      },
      tmpDir,
    );

    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.replyToAuthor).toBe("6545fc21-4b79-40b7-9b4e-c8fc6f570e59");
    expect(pending[0]?.replyToId).toBe("1771479242643");

    const deliverFn = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await recoverPendingDeliveries({
      deliver: deliverFn,
      log,
      cfg: {},
      stateDir: tmpDir,
      delay: async () => {},
    });

    expect(deliverFn).toHaveBeenCalledTimes(1);
    expect(deliverFn).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToAuthor: "6545fc21-4b79-40b7-9b4e-c8fc6f570e59",
        replyToId: "1771479242643",
      }),
    );

    await ackDelivery(id, tmpDir);
    const afterAck = await loadPendingDeliveries(tmpDir);
    expect(afterAck).toHaveLength(0);
  });
});
