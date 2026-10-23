import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createWorkerTaskControl } from "../../../packages/worker-runtime/src/worker-task-native-sections.js";
import { readPreparedSessionEntryRecords } from "./session-entry-prepared-source.js";
import { readSessionEntrySnapshotRequest } from "./session-transcript-hydration-read.worker.js";

const source = vi.hoisted(() => ({ payloads: [] as string[] }));
// mock-isolation: Feed exact JSON frames without SQLite; real framing, validation, and file I/O stay under test.
vi.mock("./session-accessor.sqlite-read.js", () => ({
  readTranscriptExportSourceReadOnlySync: (
    _scope: unknown,
    sink: { write: (json: string) => void },
  ) => {
    for (const payload of source.payloads) {
      sink.write(payload);
    }
    return { stats: { maxSeq: 3, eventCount: 3, sizeBytes: 0 } };
  },
}));

it("reuses framing storage without changing UTF-8 bytes, yielded records or partial-I/O errors", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prepared-source-framing-"));
  const filePath = path.join(directory, "records");
  const records = [
    { type: "message", message: { role: "user", content: "🦞".repeat(4096) } },
    { type: "message", message: { role: "assistant", content: "short" } },
    { type: "message", message: { role: "assistant", content: "z".repeat(12000) } },
  ];
  source.payloads = records.map((record) => JSON.stringify(record, null, 2));
  // Independent wire oracle, not output of the writer under test.
  const expected = Buffer.concat(
    source.payloads.flatMap((text) => {
      const payload = Buffer.from(text, "utf8"),
        header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length);
      return [header, payload];
    }),
  );
  const write = fs.writeSync,
    read = fs.readSync;
  const writerStorage = new Set<ArrayBufferLike>(),
    readerStorage = new Set<ArrayBufferLike>();
  let writes = 0,
    reads = 0,
    partialWrite = false,
    partialRead = false;
  const writeSpy = vi
    .spyOn(fs, "writeSync")
    .mockImplementation(
      (
        fd: number,
        buffer: NodeJS.ArrayBufferView | string,
        offset?: number | null,
        length?: number | BufferEncoding | null,
        position?: number | null,
      ) => {
        if (typeof buffer === "string" || typeof length !== "number") {
          throw new Error("Expected positional byte framing");
        }
        writerStorage.add(buffer.buffer);
        writes++;
        const bytes = !partialWrite ? Math.min(2, length) : length;
        partialWrite = true;
        return write(fd, buffer, offset, bytes, position);
      },
    );
  try {
    const control = createWorkerTaskControl(new Int32Array(new SharedArrayBuffer(4)), () => true);
    await readSessionEntrySnapshotRequest(
      {
        kind: "session-entry",
        mode: "snapshot",
        includeOriginalMessages: true,
        absPath: "synthetic",
        options: { agentId: "main", sessionId: "framing", storePath: "synthetic" },
      },
      {
        consumeInput() {},
        notify() {},
        request: async () => ({ input: { filePath }, consumed() {} }),
      },
      control,
    );
    writeSpy.mockRestore();
    expect(fs.readFileSync(filePath)).toEqual(expected);
    const readSpy = vi
      .spyOn(fs, "readSync")
      .mockImplementation(
        (
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offset?: number | fs.ReadOptions,
          length?: number,
          position?: fs.ReadPosition | null,
        ) => {
          if (typeof offset !== "number" || length === undefined) {
            throw new Error("Expected positional byte replay");
          }
          readerStorage.add(buffer.buffer);
          reads++;
          const bytes = !partialRead && length > 4 ? 3 : length;
          if (length > 4) {
            partialRead = true;
          }
          return read(fd, buffer, offset, bytes, position ?? null);
        },
      );
    try {
      const yielded = [...readPreparedSessionEntryRecords(filePath)];
      expect(yielded).toEqual(records); // Earlier decoded records survive long-to-short storage reuse.
      expect(writerStorage.size).toBe(1);
      expect(writes).toBe(4); // Three complete frames plus one deliberately short write.
      expect(readerStorage.size).toBe(2); // Fixed header and one grow-to-fit payload backing store.
      expect(reads).toBe(8); // Header/payload pairs, one short read, and EOF.
      fs.truncateSync(filePath, expected.length - 1);
      expect(() => [...readPreparedSessionEntryRecords(filePath)]).toThrow(
        "Prepared session export ended inside a record",
      );
    } finally {
      readSpy.mockRestore();
    }
  } finally {
    writeSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
