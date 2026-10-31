// @vitest-environment node
import { expect, it } from "vitest";
import { readIsobmffTrackIds } from "./chat-attachment-video-inventory.ts";

const box = (type: string, ...parts: Uint8Array[]) => {
  const data = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0));
  new DataView(data.buffer).setUint32(0, data.length);
  data.set(new TextEncoder().encode(type), 4);
  let offset = 8;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
};
const track = (id: number, version = 0) => {
  const header = new Uint8Array(version === 1 ? 24 : 16);
  header[0] = version;
  new DataView(header.buffer).setUint32(version === 1 ? 20 : 12, id);
  return box("trak", box("tkhd", header));
};
it("accounts for every track, including IDs with no audio/video sample description", async () => {
  const movie = box("moov", track(1), track(2, 1), track(3));
  expect(await readIsobmffTrackIds(new Blob([box("free"), movie]))).toEqual([1, 2, 3]);
  const zero = movie.slice();
  new DataView(zero.buffer).setUint32(0, 0);
  expect(await readIsobmffTrackIds(new Blob([zero]))).toEqual([1, 2, 3]);
});
it.each([
  box("moov", track(1), track(1)),
  box("moov", track(0)),
  box("moov", box("trak")),
  box("moov", track(1, 2)),
  box("moov", track(1)).subarray(0, 12),
  new Uint8Array([0, 0, 0, 1, 109, 111, 111, 118]),
])("refuses an ambiguous or truncated inventory %#", async (bytes) => {
  await expect(readIsobmffTrackIds(new Blob([bytes]))).rejects.toThrow();
});
