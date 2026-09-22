import assert from "node:assert/strict";
import { once } from "node:events";
import {
  isMarkedAsUntransferable,
  markAsUntransferable,
  MessageChannel,
} from "node:worker_threads";
import { expect, it } from "vitest";
import { ownedWorkerBytes } from "./worker-transfer-bytes.js";

it.each(["full", "sliced", "pooled", "shared", "marked"] as const)(
  "transfers %s bytes without exposing or detaching unrelated storage",
  async (kind) => {
    const storage =
      kind === "pooled"
        ? Buffer.allocUnsafe(12).fill(91)
        : kind === "shared"
          ? new Uint8Array(new SharedArrayBuffer(12)).fill(91)
          : new Uint8Array(kind === "sliced" ? 12 : 4).fill(91);
    const source = kind === "full" || kind === "marked" ? storage : storage.subarray(4, 8);
    source.set([0, 127, 128, 255]);
    if (kind === "marked") {
      markAsUntransferable(source.buffer);
      expect(isMarkedAsUntransferable(source.buffer)).toBe(true);
    }
    const before = [...storage];
    const bytes = ownedWorkerBytes(source);
    const { port1, port2 } = new MessageChannel();
    try {
      const message = once(port2, "message");
      port1.postMessage(bytes, [bytes.buffer]);
      const received: unknown = (await message)[0];
      assert(received instanceof Uint8Array);
      expect([...received]).toEqual([0, 127, 128, 255]);
      expect(received.buffer.byteLength).toBe(4);
      expect(bytes.byteLength).toBe(0);
      expect(bytes.buffer.byteLength).toBe(0);
      if (kind === "full") {
        expect(source.byteLength).toBe(0);
      } else {
        expect([...storage]).toEqual(before);
      }
    } finally {
      port1.close();
      port2.close();
    }
  },
);
