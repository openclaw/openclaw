import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCredentialFileCount, pruneStaleCredentials } from "./auth-store.js";

describe("pruneStaleCredentials", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-creds-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("returns null when directory does not exist", async () => {
    const result = await pruneStaleCredentials("/nonexistent/path");
    expect(result).toBeNull();
  });

  it("returns null when file count is below threshold", async () => {
    // Create fewer than 500 files
    for (let i = 0; i < 100; i++) {
      await fs.writeFile(path.join(testDir, `pre-key-${i}.json`), "{}");
    }
    const result = await pruneStaleCredentials(testDir);
    expect(result).toBeNull();
  });

  it("prunes old pre-key files when above threshold", async () => {
    // Create 600 files (above 500 threshold)
    const now = Date.now();
    for (let i = 0; i < 600; i++) {
      const filePath = path.join(testDir, `pre-key-${i}.json`);
      await fs.writeFile(filePath, "{}");
      // Set older mtime for first 400 files
      if (i < 400) {
        const oldTime = new Date(now - (600 - i) * 1000);
        await fs.utimes(filePath, oldTime, oldTime);
      }
    }

    const countBefore = getCredentialFileCount(testDir);
    expect(countBefore).toBe(600);

    const result = await pruneStaleCredentials(testDir);
    expect(result).not.toBeNull();
    expect(result!.pruned).toBeGreaterThan(0);
    expect(result!.remaining).toBeLessThan(600);

    // Should keep ~100 most recent files
    const countAfter = getCredentialFileCount(testDir);
    expect(countAfter).toBeLessThanOrEqual(200); // Some buffer for timing
  });

  it("preserves creds.json and creds.json.bak", async () => {
    // Create 600 files including creds.json
    for (let i = 0; i < 598; i++) {
      await fs.writeFile(path.join(testDir, `pre-key-${i}.json`), "{}");
    }
    await fs.writeFile(path.join(testDir, "creds.json"), '{"me":{"id":"123"}}');
    await fs.writeFile(path.join(testDir, "creds.json.bak"), '{"me":{"id":"123"}}');

    await pruneStaleCredentials(testDir);

    // creds.json should still exist
    const credsExists = await fs
      .access(path.join(testDir, "creds.json"))
      .then(() => true)
      .catch(() => false);
    expect(credsExists).toBe(true);

    const bakExists = await fs
      .access(path.join(testDir, "creds.json.bak"))
      .then(() => true)
      .catch(() => false);
    expect(bakExists).toBe(true);
  });
});
