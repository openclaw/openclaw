import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { materializeSessionArchiveForRead } from "./archive-compression.js";
import {
  publishEncodedSessionTranscriptArchive,
  writeTranscriptArchive,
} from "./session-accessor.sqlite-archive-artifact.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function archiveInput() {
  const bytes = Buffer.from("retained transcript\n");
  return {
    archiveDirectory: tempDirs.make("openclaw-archive-publication-"),
    archiveName: "session.jsonl",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("encoded transcript archive publication", () => {
  it("reads and reuses highly compressed writer archives through a bounded stream", async () => {
    const { archiveDirectory } = archiveInput();
    const content = "x".repeat(2 * 1024 * 1024);
    const input = {
      archiveDirectory,
      content,
      sessionId: "high-expansion",
      reason: "deleted" as const,
    };
    const archivePath = writeTranscriptArchive(input);
    expect(fs.statSync(archivePath).size).toBeLessThan(1024);
    const chunkSizes: number[] = [];
    const createWriteStream = fs.createWriteStream;
    vi.spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = createWriteStream(...args);
      stream.on("pipe", (source: Readable) => {
        source.on("data", (chunk: Buffer) => chunkSizes.push(chunk.byteLength));
      });
      return stream;
    });
    const cachePath = await materializeSessionArchiveForRead(archivePath);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(content);
    expect(chunkSizes.reduce((sum, size) => sum + size, 0)).toBe(Buffer.byteLength(content));
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(64 * 1024);
    expect(writeTranscriptArchive(input)).toBe(archivePath);
  });

  it.each(["writeFileSync", "fsyncSync"] as const)(
    "cleans its unpublished temporary file when %s fails",
    (operation) => {
      const input = archiveInput();
      const failure = Object.assign(new Error("archive storage is full"), { code: "ENOSPC" });
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw failure;
      });

      expect(() => publishEncodedSessionTranscriptArchive(input)).toThrow(failure);
      expect(fs.readdirSync(input.archiveDirectory)).toEqual([]);

      const archivePath = publishEncodedSessionTranscriptArchive(input);
      expect(fs.readFileSync(archivePath)).toEqual(input.bytes);
      expect(fs.readdirSync(input.archiveDirectory)).toEqual([input.archiveName]);
    },
  );

  it("preserves a colliding temporary file that it did not create", () => {
    const input = archiveInput();
    const originalOpen = fs.openSync;
    const priorBytes = Buffer.from("another publisher's temporary bytes");
    let collisionPath = "";
    vi.spyOn(fs, "openSync").mockImplementationOnce((filePath, flags, mode) => {
      collisionPath = filePath.toString();
      fs.writeFileSync(filePath, priorBytes);
      return originalOpen(filePath, flags, mode);
    });

    expect(() => publishEncodedSessionTranscriptArchive(input)).toThrow(/EEXIST/);
    expect(fs.readFileSync(collisionPath)).toEqual(priorBytes);
    expect(fs.readdirSync(input.archiveDirectory)).toEqual([path.basename(collisionPath)]);
  });
});
