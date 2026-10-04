import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptStorageObject,
  encryptedStorageSize,
  encryptStorageObject,
  plaintextStorageSize,
} from "./encryption.js";

const STORAGE_SEGMENT_BYTES = 1_048_576;

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const collected: Uint8Array[] = [];
  for await (const chunk of body) {
    collected.push(chunk);
  }
  return Buffer.concat(collected);
}

async function* chunks(bytes: Uint8Array) {
  // Transport chunk boundaries do not coincide with encryption framing.
  for (let offset = 0; offset < bytes.length; offset += 7919) {
    yield bytes.subarray(offset, offset + 7919);
  }
}

describe("OCSTOR1 encryption", () => {
  it.each([0, STORAGE_SEGMENT_BYTES, STORAGE_SEGMENT_BYTES + 1])(
    "round trips %i plaintext bytes with exact ciphertext size",
    async (size) => {
      const key = randomBytes(32);
      const plaintext = Buffer.alloc(size, 0x67);
      const ciphertext = await collect(encryptStorageObject(chunks(plaintext), key));
      expect(ciphertext.length).toBe(encryptedStorageSize(size));
      expect(plaintextStorageSize(ciphertext.length)).toBe(size);
      expect(plaintext.equals(await collect(decryptStorageObject(chunks(ciphertext), key)))).toBe(
        true,
      );
    },
  );

  it("rejects impossible stored sizes", () => {
    const emptySize = encryptedStorageSize(0);
    const fullSegmentSize = encryptedStorageSize(STORAGE_SEGMENT_BYTES);
    for (const size of [
      -1,
      0,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      emptySize + 0.5,
      emptySize - 1,
      fullSegmentSize - 16,
      fullSegmentSize - 1,
      (STORAGE_SEGMENT_BYTES + 16) * 0x100000000 + emptySize,
    ]) {
      expect(() => plaintextStorageSize(size)).toThrow();
    }
  });

  it("rejects truncation, reordering, header tampering, trailing bytes and the wrong key", async () => {
    const key = randomBytes(32);
    const ciphertext = await collect(
      encryptStorageObject(chunks(Buffer.alloc(2 * STORAGE_SEGMENT_BYTES)), key),
    );
    const headerEnd = 12 + ciphertext.readUInt32BE(8);
    const segmentBytes = STORAGE_SEGMENT_BYTES + 16;
    const reordered = Buffer.concat([
      ciphertext.subarray(0, headerEnd),
      ciphertext.subarray(headerEnd + segmentBytes, headerEnd + 2 * segmentBytes),
      ciphertext.subarray(headerEnd, headerEnd + segmentBytes),
      ciphertext.subarray(headerEnd + 2 * segmentBytes),
    ]);
    const changedHeader = Buffer.from(ciphertext);
    const saltOffset = changedHeader.indexOf('"objSalt":"') + '"objSalt":"'.length;
    changedHeader[saltOffset] = changedHeader[saltOffset] === 65 ? 66 : 65;
    for (const corrupt of [
      ciphertext.subarray(0, -16),
      reordered,
      changedHeader,
      Buffer.concat([ciphertext, Buffer.from([1])]),
    ]) {
      await expect(collect(decryptStorageObject(chunks(corrupt), key))).rejects.toThrow();
    }
    await expect(
      collect(decryptStorageObject(chunks(ciphertext), randomBytes(32))),
    ).rejects.toThrow();
  });

  it("bounds each ciphertext yield and closes the source on early cancellation", async () => {
    let closed = false;
    async function* source() {
      try {
        yield Buffer.alloc(4 * STORAGE_SEGMENT_BYTES);
      } finally {
        closed = true;
      }
    }
    let yields = 0;
    for await (const chunk of encryptStorageObject(source(), randomBytes(32))) {
      expect(chunk.byteLength).toBeLessThanOrEqual(STORAGE_SEGMENT_BYTES + 16);
      if (++yields === 2) {
        break;
      }
    }
    expect(closed).toBe(true);
  });
});
