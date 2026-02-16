import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cleanOldMedia, ensureMediaDir, resetCleanupThrottleForTest } from "./store.js";

// We'll set process.env.OPENCLAW_STATE_DIR to redirect the config dir
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let tempDir: string;

describe("Media Store Cleanup", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-test-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    resetCleanupThrottleForTest();
  });

  afterEach(async () => {
    if (originalStateDir) {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
    // Clean up temp dir
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("cleans up old files in the root media directory", async () => {
    const mediaDir = await ensureMediaDir();
    const filePath = path.join(mediaDir, "old-file.txt");
    await fs.writeFile(filePath, "test content");
    
    // Set mtime to 1 hour ago
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(filePath, oldTime, oldTime);

    // Clean files older than 30 minutes
    await cleanOldMedia(30 * 60 * 1000);

    // Should be gone
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("recursively cleans up files in subdirectories (e.g. inbound)", async () => {
    // This demonstrates the bug fix: cleanOldMedia is now recursive
    const mediaDir = await ensureMediaDir();
    const inboundDir = path.join(mediaDir, "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    
    const filePath = path.join(inboundDir, "old-inbound-file.txt");
    await fs.writeFile(filePath, "test content");
    
    // Set mtime to 1 hour ago
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(filePath, oldTime, oldTime);

    // Clean files older than 30 minutes
    await cleanOldMedia(30 * 60 * 1000);

    // Should be deleted now
    await expect(fs.access(filePath)).rejects.toThrow();
  });
});
