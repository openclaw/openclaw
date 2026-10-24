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
import { SessionArchivePlaintextLimitError } from "./archive-limits.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("archive compression", () => {
  it("decodes both plain bytes and compressed archive bytes", () => {
    const content = `${JSON.stringify({ type: "message", body: "archive round trip" })}\n`;
    const encoded = encodeSessionArchiveContent(content);

    expect(decodeSessionArchiveBytes(Buffer.from(content, "utf8"), false)).toBe(content);
    expect(decodeSessionArchiveBytes(encoded.bytes, encoded.suffix !== "")).toBe(content);
  });

  it("invalidates a materialized cache when its source archive is removed", () => {
    const encoded = encodeSessionArchiveContent("cached archive contents\n");
    expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, `removed.jsonl.deleted.2026-07-11${encoded.suffix}`);
    fs.writeFileSync(archivePath, encoded.bytes);
    const cachePath = materializeSessionArchiveForRead(archivePath);
    expect(fs.existsSync(cachePath)).toBe(true);

    fs.rmSync(archivePath);

    expect(() => materializeSessionArchiveForRead(archivePath)).toThrow();
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("keeps plain archives readable", () => {
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
    expect(first.endsWith(".jsonl")).toBe(true);
  });

  it("refuses compressed archives whose plaintext exceeds the budget", () => {
    const encoded = encodeSessionArchiveContent("x".repeat(10_000));
    expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, `bomb.jsonl.deleted.2026-07-11${encoded.suffix}`);
    fs.writeFileSync(archivePath, encoded.bytes);
    const budget = { maxPlaintextBytes: 1024 };

    expect(() => readSessionArchiveContentSync(archivePath, budget)).toThrow(
      SessionArchivePlaintextLimitError,
    );
    expect(() => decodeSessionArchiveBytes(encoded.bytes, true, budget)).toThrow(
      SessionArchivePlaintextLimitError,
    );
  });

  it("refuses plain archives larger than the budget", () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "sess.jsonl.reset.2026-07-11T00-00-00.000Z");
    fs.writeFileSync(archivePath, "x".repeat(2048), "utf8");
    const budget = { maxPlaintextBytes: 1024 };

    expect(() => readSessionArchiveContentSync(archivePath, budget)).toThrow(
      SessionArchivePlaintextLimitError,
    );
    expect(() => decodeSessionArchiveBytes(Buffer.alloc(2048, 0x78), false, budget)).toThrow(
      SessionArchivePlaintextLimitError,
    );
  });

  it("keeps archives that fit the budget readable", () => {
    const content = `${JSON.stringify({ type: "message", body: "fits" })}\n`;
    const encoded = encodeSessionArchiveContent(content);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, `ok.jsonl.deleted.2026-07-11${encoded.suffix}`);
    fs.writeFileSync(archivePath, encoded.bytes);
    const budget = { maxPlaintextBytes: Buffer.byteLength(content, "utf8") };

    expect(readSessionArchiveContentSync(archivePath, budget)).toBe(content);
    expect(decodeSessionArchiveBytes(encoded.bytes, true, budget)).toBe(content);
  });
});
