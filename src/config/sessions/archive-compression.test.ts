// Round-trip and naming coverage for the archived-transcript zstd cold tier.
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

// Keep the materialized read cache inside a temp dir so the budget assertions are isolated
// from other readers of the real /tmp/openclaw cache.
const cacheRoot = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => cacheRoot.dir,
}));
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("archive compression", () => {
  it("streams a multi-frame expansion bomb to the cache without changing the archive", async () => {
    // Concatenated frames decode back to back; the test never allocates the plaintext itself.
    const frame = zstdCompressSync(Buffer.alloc(1024 * 1024, "x"));
    const bytes = Buffer.concat(Array.from({ length: 64 }, () => frame));
    expect(bytes.length).toBeLessThan(16 * 1024);
    const archivePath = path.join(tempDirs.make("openclaw-archive-zstd-"), "bomb.jsonl.zst");
    fs.writeFileSync(archivePath, bytes);

    const cachePath = await materializeSessionArchiveForRead(archivePath);

    expect(fs.statSync(cachePath).size).toBe(64 * 1024 * 1024);
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
    fs.rmSync(cachePath);
  });

  it("writes compressed bytes compatible with Node zstd", () => {
    const content = `${JSON.stringify({ type: "message", body: "archive round trip" })}\n`;
    const encoded = encodeSessionArchiveContent(content);

    expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
    expect(zstdDecompressSync(encoded.bytes).toString("utf8")).toBe(content);
  });

  it("invalidates a materialized cache when its source archive is removed", async () => {
    const encoded = encodeSessionArchiveContent("cached archive contents\n");
    expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, `removed.jsonl.deleted.2026-07-11${encoded.suffix}`);
    fs.writeFileSync(archivePath, encoded.bytes);
    const cachePath = await materializeSessionArchiveForRead(archivePath);
    expect(fs.existsSync(cachePath)).toBe(true);

    fs.rmSync(archivePath);

    await expect(materializeSessionArchiveForRead(archivePath)).rejects.toThrow();
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("keeps plain archives readable", () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "sess.jsonl.reset.2026-07-11T00-00-00.000Z");
    fs.writeFileSync(archivePath, "plain\n", "utf8");

    expect(readSessionArchiveContentSync(archivePath, 6)).toBe("plain\n");
  });

  it("materializes compressed archives to a stable plain JSONL cache path", async () => {
    const content = `${JSON.stringify({ type: "message", body: "cold".repeat(256 * 1024) })}\n`;
    const encoded = encodeSessionArchiveContent(content);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(
      dir,
      `sess.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(archivePath, encoded.bytes);

    const first = await materializeSessionArchiveForRead(archivePath);
    const second = await materializeSessionArchiveForRead(archivePath);

    expect(second).toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe(content);
    expect(first.endsWith(".jsonl")).toBe(true);
  });
});

describe("archive read cache budget", () => {
  it("bounds the materialized cache by entries and bytes", async () => {
    const workspace = tempDirs.make("openclaw-archive-budget-");
    cacheRoot.dir = workspace;
    const cacheDir = path.join(workspace, "session-archive-read-cache");
    const archives = path.join(workspace, "archives");
    fs.mkdirSync(archives, { recursive: true });
    const payload = zstdCompressSync(Buffer.from(`${"x".repeat(1024)}\n`));

    for (let index = 0; index < 80; index += 1) {
      const archivePath = path.join(archives, `archive-${index}.jsonl.zst`);
      fs.writeFileSync(archivePath, payload);
      await materializeSessionArchiveForRead(archivePath);
    }

    const entries = fs.readdirSync(cacheDir).filter((name) => !name.endsWith(".tmp"));
    const totalBytes = entries.reduce(
      (sum, name) => sum + fs.statSync(path.join(cacheDir, name)).size,
      0,
    );
    expect(entries.length).toBeLessThanOrEqual(64);
    expect(totalBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});
