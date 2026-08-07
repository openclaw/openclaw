import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

let readSessionArchiveContentSync: typeof import("./archive-compression.js").readSessionArchiveContentSync;
let writeSqliteTranscriptArchive: typeof import("./session-accessor.sqlite-archive.js").writeSqliteTranscriptArchive;

describe("SQLite transcript archive sync-only zstd fallback", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let archiveDirectory: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:zlib", async () => {
      const actual = await vi.importActual<typeof import("node:zlib")>("node:zlib");
      return {
        ...actual,
        default: {
          ...actual,
          createZstdCompress: undefined,
          createZstdDecompress: undefined,
        },
      };
    });
    ({ readSessionArchiveContentSync } = await import("./archive-compression.js"));
    ({ writeSqliteTranscriptArchive } = await import("./session-accessor.sqlite-archive.js"));
    archiveDirectory = tempDirs.make("openclaw-archive-sync-zstd-");
  });

  afterEach(() => {
    vi.doUnmock("node:zlib");
    vi.resetModules();
  });

  it("keeps multi-chunk archives complete and reusable without buffering for zstd", async () => {
    const sessionId = "sync-only-zstd-session";
    const content = `${JSON.stringify({ id: sessionId, text: "compressible".repeat(8192) })}\n`;
    const bytes = Buffer.from(content, "utf8");

    const first = await writeSqliteTranscriptArchive({
      archiveDirectory,
      contentChunks: splitBuffer(bytes, 97),
      reason: "deleted",
      sessionId,
    });
    const second = await writeSqliteTranscriptArchive({
      archiveDirectory,
      contentChunks: splitBuffer(bytes, 4093),
      reason: "deleted",
      sessionId,
    });

    expect(first.endsWith(".zst")).toBe(false);
    expect(second).toBe(first);
    expect(readSessionArchiveContentSync(first)).toBe(content);
    expect(
      fs
        .readdirSync(archiveDirectory)
        .filter((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`)),
    ).toHaveLength(1);
  });
});

function* splitBuffer(content: Buffer, chunkSize: number): IterableIterator<Buffer> {
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    yield content.subarray(offset, Math.min(offset + chunkSize, content.length));
  }
}
