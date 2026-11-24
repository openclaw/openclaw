// Mediabunny exposes only audio/video tracks from ISO-BMFF. Audit track IDs in
// container headers too, so a compatible copy cannot silently lose hidden tracks.
export async function readIsobmffTrackIds(file: Blob): Promise<number[]> {
  async function* boxes(start: number, end: number) {
    for (let offset = start; offset < end;) {
      if (end - offset < 8) {
        throw new Error("Truncated box header");
      }
      const header = new DataView(
        await file.slice(offset, Math.min(offset + 16, end)).arrayBuffer(),
      );
      const size32 = header.getUint32(0);
      const headerSize = size32 === 1 ? 16 : 8;
      const size = size32 === 1 ? Number(header.getBigUint64(8)) : size32 || end - offset;
      if (!Number.isSafeInteger(size) || size < headerSize || size > end - offset) {
        throw new Error("Invalid box size");
      }
      const type = String.fromCharCode(...new Uint8Array(header.buffer, 4, 4));
      yield { type, start: offset + headerSize, end: offset + size };
      offset += size;
    }
  }
  let movies = 0;
  const ids: number[] = [];
  for await (const box of boxes(0, file.size)) {
    if (box.type !== "moov") {
      continue;
    }
    if (++movies !== 1) {
      throw new Error("Ambiguous movie inventory");
    }
    for await (const track of boxes(box.start, box.end)) {
      if (track.type !== "trak") {
        continue;
      }
      let id: number | undefined;
      for await (const child of boxes(track.start, track.end)) {
        if (child.type !== "tkhd") {
          continue;
        }
        if (id !== undefined) {
          throw new Error("Duplicate track header");
        }
        const header = new DataView(
          await file.slice(child.start, Math.min(child.start + 24, child.end)).arrayBuffer(),
        );
        const version = header.getUint8(0);
        if (version !== 0 && version !== 1) {
          throw new Error("Unknown track header version");
        }
        id = header.getUint32(version === 0 ? 12 : 20);
      }
      if (!id || ids.includes(id)) {
        throw new Error("Missing or duplicate track ID");
      }
      ids.push(id);
    }
  }
  if (movies !== 1 || ids.length === 0) {
    throw new Error("Missing track inventory");
  }
  return ids;
}
