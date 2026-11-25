import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { transformArchiveBytesIncrementally } from "./state-migrations.transcript-archive-stream.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type TransformOptions = Parameters<typeof transformArchiveBytesIncrementally>[0];
const unchanged = (line: string) => ({ changed: false, content: line });
const encode = (bytes: Buffer, encoding: TransformOptions["encoding"]) =>
  encoding === "zstd" ? zstdCompressSync(bytes) : bytes;
const decode = (bytes: Buffer, encoding: TransformOptions["encoding"]) =>
  encoding === "zstd" ? zstdDecompressSync(bytes) : bytes;
const transform = (
  bytes: Buffer,
  owner: string,
  options: Partial<Omit<TransformOptions, "bytes" | "owner">> = {},
) =>
  transformArchiveBytesIncrementally({
    bytes,
    owner,
    encoding: "zstd",
    transformLine: unchanged,
    ...options,
  });

it.each(["identity", "zstd"] as const)(
  "preserves unchanged bytes, UTF-8, and record boundaries across %s chunks",
  async (encoding) => {
    const chunkSize = encoding === "identity" ? 1024 * 1024 : 16 * 1024;
    const prefix = '{"text":"';
    const firstText = `${"x".repeat(chunkSize - prefix.length - 1)}🙂`;
    const records = Array.from({ length: 2_000 }, (_, i) => `record-${i}-🙂`);
    const expected = [firstText, ...records, "終わり"];
    const jsonl = expected.map((text) => JSON.stringify({ text })).join("\n");
    const bytes = Buffer.from(encoding === "zstd" ? `${jsonl}\n` : jsonl);
    const source = encode(bytes, encoding);
    const before = sha256(source);
    const seen: string[] = [];
    const transformed = await transform(source, "utf8", {
      encoding,
      transformLine: (line) => {
        seen.push((JSON.parse(line) as { text: string }).text);
        return { changed: false, content: line };
      },
    });
    expect(seen).toEqual(expected);
    expect(transformed.changed).toBe(false);
    expect(transformed.bytes).toBe(source);
    expect(sha256(transformed.bytes)).toBe(before);
    expect(decode(transformed.bytes, encoding)).toEqual(bytes);
  },
);

it("propagates a damaged zstd stream", async () => {
  await expect(transform(Buffer.from("not a zstd archive"), "damaged")).rejects.toThrow();
});

it.each(["identity", "zstd"] as const)(
  "removes a terminal NUL suffix from a %s archive without buffering decoded content",
  async (encoding) => {
    const content = Buffer.from('{"n":1}\n{"n":2}\0\0', "utf8");
    const transformed = await transform(encode(content, encoding), "nul-tail", { encoding });
    expect(transformed.changed).toBe(true);
    expect(decode(transformed.bytes, encoding).toString("utf8")).toBe('{"n":1}\n{"n":2}');
  },
);

it("rejects an all-NUL archive consistently with the full-content transform", async () => {
  await expect(transform(Buffer.alloc(32), "all-nul", { encoding: "identity" })).rejects.toThrow(
    "all-nul contains no JSONL records before its terminal NUL suffix",
  );
});

it("retains JSONL blank-record validation", async () => {
  const source = zstdCompressSync(Buffer.from('{"n":1}\n\n{"n":2}\n', "utf8"));
  await expect(transform(source, "blank")).rejects.toThrow(
    "blank contains a blank JSONL record at line 2",
  );
});

it.each(["identity", "zstd"] as const)(
  "rejects malformed UTF-8 in a later %s chunk before returning transformed bytes",
  async (encoding) => {
    const source = Buffer.concat([
      Buffer.from('{"text":"first"}\n{"text":"' + "x".repeat(1024 * 1024) + '"}\n{"text":"'),
      Buffer.from([0xf0, 0x9f]),
    ]);
    await expect(
      transform(encode(source, encoding), "invalid-utf8", {
        encoding,
        transformLine: () => ({ changed: true, content: '{"text":"changed"}' }),
      }),
    ).rejects.toThrow("invalid-utf8 must be valid UTF-8");
  },
);
