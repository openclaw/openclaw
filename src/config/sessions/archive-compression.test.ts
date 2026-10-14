// Round-trip and naming coverage for the archived-transcript zstd cold tier.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  decodeSessionArchiveBytes,
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("archive compression", () => {
  it("decodes both plain bytes and runtime-supported compressed archive bytes", () => {
    const content = `${JSON.stringify({ type: "message", body: "archive round trip" })}\n`;
    const encoded = encodeSessionArchiveContent(content);

    expect(decodeSessionArchiveBytes(Buffer.from(content, "utf8"), false)).toBe(content);
    expect(decodeSessionArchiveBytes(encoded.bytes, encoded.suffix !== "")).toBe(content);
  });

  it("invalidates a materialized cache when its source archive is removed", () => {
    const encoded = encodeSessionArchiveContent("cached archive contents\n");
    if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
      return;
    }
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, `removed.jsonl.deleted.2026-07-11${encoded.suffix}`);
    fs.writeFileSync(archivePath, encoded.bytes);
    const cachePath = materializeSessionArchiveForRead(archivePath);
    expect(fs.existsSync(cachePath)).toBe(true);

    fs.rmSync(archivePath);

    expect(() => materializeSessionArchiveForRead(archivePath)).toThrow();
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("keeps plain archives readable regardless of runtime zstd support", () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "sess.jsonl.reset.2026-07-11T00-00-00.000Z");
    fs.writeFileSync(archivePath, "plain\n", "utf8");

    expect(readSessionArchiveContentSync(archivePath)).toBe("plain\n");
  });

  it("materializes compressed archives to a stable plain JSONL cache path", () => {
    const content = `${JSON.stringify({ type: "message", body: "cold" })}\n`;
    const encoded = encodeSessionArchiveContent(content);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(
      dir,
      `sess.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(archivePath, encoded.bytes);

    const first = materializeSessionArchiveForRead(archivePath);
    const second = materializeSessionArchiveForRead(archivePath);

    expect(second).toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe(content);
    if (encoded.suffix === "") {
      // Plain archives pass through untouched.
      expect(first).toBe(archivePath);
    } else {
      expect(first.endsWith(".jsonl")).toBe(true);
    }
  });
});
