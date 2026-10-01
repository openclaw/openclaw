import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { appendBackupManifest } from "./backup-create-stream.js";

it.each([1, 511, 512, 1023, 1024, 1025, 8193])(
  "replaces the final tar terminator after traversal with %i-byte chunks",
  async (chunkSize) => {
    const payload = Buffer.concat([
      Buffer.from(Array.from({ length: 7169 }, (_, index) => index % 251)),
      Buffer.alloc(1024),
    ]);
    const manifest = Buffer.from("manifest captured after traversal");
    let traversed = false;
    async function* chunks() {
      yield Buffer.alloc(0);
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        yield payload.subarray(offset, offset + chunkSize);
      }
      traversed = true;
    }
    const archive = await buffer(
      appendBackupManifest(chunks(), () => {
        expect(traversed).toBe(true);
        return manifest;
      }),
    );
    expect(gunzipSync(archive)).toEqual(Buffer.concat([payload.subarray(0, -1024), manifest]));
  },
);
