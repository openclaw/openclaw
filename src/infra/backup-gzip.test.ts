import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { gzipInParallel } from "./backup-gzip.js";

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
}

it("emits ordered gzip members that stock readers decode as one stream", async () => {
  // Uneven chunks straddle the block boundary; random bytes expose reordering.
  const input = [randomBytes(3 * 1024 * 1024), randomBytes(7 * 1024 * 1024 + 13), randomBytes(1)];

  const members = await collect(gzipInParallel(Readable.from(input)));

  expect(gunzipSync(Buffer.concat(members)).equals(Buffer.concat(input))).toBe(true);
  // Each member stands alone, so the archive stays a plain multi-member gzip file.
  expect(members.map((member) => gunzipSync(member).length)).toEqual([
    4 * 1024 * 1024,
    4 * 1024 * 1024,
    2 * 1024 * 1024 + 14,
  ]);
});

it("writes a valid empty gzip stream for empty input", async () => {
  const members = await collect(gzipInParallel(Readable.from([])));

  expect(members.map((member) => gunzipSync(member).length)).toEqual([0]);
});
