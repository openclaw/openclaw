import { PassThrough, Readable } from "node:stream";
import { expect, it } from "vitest";
import { skillWorkerLines } from "./workspace-worker-io.js";

it("preserves Unicode in skill requests across UTF-8 chunks and EOF", async () => {
  const request = { text: "雪🦀\u0085NEL\u2028LS\u2029PS" };
  const bytes = Buffer.from(JSON.stringify(request));
  const lines = skillWorkerLines(Readable.from([...bytes].map((byte) => Buffer.from([byte]))));
  try {
    await expect(lines.read()).resolves.toEqual(request);
    await expect(lines.read()).rejects.toThrow("transport closed");
  } finally {
    lines.close();
  }
});

it("refuses malformed and oversized requests through the owning worker boundary", async () => {
  const malformed = skillWorkerLines(Readable.from(['{"unfinished":']));
  await expect(malformed.read()).rejects.toThrow(/JSON/);
  malformed.close();
  const input = new PassThrough();
  const oversized = skillWorkerLines(input);
  const pending = oversized.read();
  input.write(Buffer.alloc(12 * 1024 * 1024 + 1, 0x78));
  await expect(pending).rejects.toThrow("byte limit");
  oversized.close();
});
