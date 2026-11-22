import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { gzipInParallel } from "./backup-gzip.js";

const BLOCK_BYTES = 4 * 1024 * 1024;

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    gzip: (input: Buffer, callback: (error: Error | null, result: Buffer) => void) => {
      if (input.subarray(0, 10).toString() === "fail-block") {
        setImmediate(() => callback(new Error("block failed"), Buffer.alloc(0)));
        return;
      }
      actual.gzip(input, callback);
    },
  };
});

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
    BLOCK_BYTES,
    BLOCK_BYTES,
    2 * 1024 * 1024 + 14,
  ]);
});

it("reads ahead of a slow consumer by at most its compression width", async () => {
  let pulled = 0;
  async function* source() {
    for (let index = 0; index < 6; index += 1) {
      pulled += 1;
      yield Buffer.alloc(BLOCK_BYTES, index);
    }
  }
  const members = gzipInParallel(source(), 2);
  const observed: number[] = [];

  for (let index = 0; index < 3; index += 1) {
    const member = await members.next();
    expect(gunzipSync(member.value)[0]).toBe(index);
    observed.push(pulled);
  }
  await members.return(undefined);

  expect(observed).toEqual([2, 3, 4]);
});

it("reports a failed block in order and stops reading the source", async () => {
  let closed = false;
  async function* source() {
    try {
      for (const fill of ["first", "fail-block", "third", "fourth", "fifth"]) {
        yield Buffer.alloc(BLOCK_BYTES, fill);
      }
    } finally {
      closed = true;
    }
  }
  const members = gzipInParallel(source(), 2);

  expect(
    gunzipSync((await members.next()).value)
      .subarray(0, 5)
      .toString(),
  ).toBe("first");
  await expect(members.next()).rejects.toThrow("block failed");
  expect(closed).toBe(true);
  expect((await members.next()).done).toBe(true);
});

it("writes a valid empty gzip stream for empty input", async () => {
  const members = await collect(gzipInParallel(Readable.from([])));

  expect(members.map((member) => gunzipSync(member).length)).toEqual([0]);
});
