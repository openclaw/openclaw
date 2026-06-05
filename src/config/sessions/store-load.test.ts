// Session store load tests cover startup sweep of orphaned atomic-write .tmp files.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { sweepOrphanSessionStoreTemps } from "./store-load.js";

describe("sweepOrphanSessionStoreTemps", () => {
  const uuid = "0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

  it("deletes stale orphan temp files matching the store basename", async () => {
    await withTempDir({ prefix: "sweep-test" }, async (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");

      // Create a stale orphan (older than 5 min)
      const staleOrphan = path.join(tmpDir, `sessions.json.12345.${uuid}.tmp`);
      fs.writeFileSync(staleOrphan, "stale", "utf-8");
      // Backdate mtime to 10 minutes ago
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      fs.utimesSync(staleOrphan, tenMinAgo / 1000, tenMinAgo / 1000);

      // Create a fresh orphan (younger than 5 min — should be preserved)
      const freshOrphan = path.join(tmpDir, `sessions.json.99999.${uuid}.tmp`);
      fs.writeFileSync(freshOrphan, "fresh", "utf-8");

      // Create an unrelated temp file (should not be touched)
      const unrelated = path.join(tmpDir, "other.tmp");
      fs.writeFileSync(unrelated, "unrelated", "utf-8");
      fs.utimesSync(unrelated, tenMinAgo / 1000, tenMinAgo / 1000);

      sweepOrphanSessionStoreTemps(storePath);

      // Stale orphan matching the store basename should be deleted
      expect(fs.existsSync(staleOrphan)).toBe(false);
      // Fresh orphan should remain (not old enough)
      expect(fs.existsSync(freshOrphan)).toBe(true);
      // Unrelated temp files should not be touched
      expect(fs.existsSync(unrelated)).toBe(true);
    });
  });

  it("does nothing when no orphan temp files exist", async () => {
    await withTempDir({ prefix: "sweep-empty" }, async (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      fs.writeFileSync(storePath, "{}", "utf-8");

      expect(() => sweepOrphanSessionStoreTemps(storePath)).not.toThrow();
    });
  });

  it("handles non-existent store directory gracefully", () => {
    const storePath = "/tmp/nonexistent-dir-89520/sessions.json";
    expect(() => sweepOrphanSessionStoreTemps(storePath)).not.toThrow();
  });

  it("only deletes temp files for the matching store basename", async () => {
    await withTempDir({ prefix: "sweep-multi" }, async (tmpDir) => {
      const storePath = path.join(tmpDir, "my-sessions.json");
      const tenMinAgo = Date.now() - 10 * 60 * 1000;

      const matchingOrphan = path.join(tmpDir, `my-sessions.json.12345.${uuid}.tmp`);
      fs.writeFileSync(matchingOrphan, "match", "utf-8");
      fs.utimesSync(matchingOrphan, tenMinAgo / 1000, tenMinAgo / 1000);

      const otherStoreOrphan = path.join(tmpDir, `other-sessions.json.12345.${uuid}.tmp`);
      fs.writeFileSync(otherStoreOrphan, "other", "utf-8");
      fs.utimesSync(otherStoreOrphan, tenMinAgo / 1000, tenMinAgo / 1000);

      sweepOrphanSessionStoreTemps(storePath);

      expect(fs.existsSync(matchingOrphan)).toBe(false);
      expect(fs.existsSync(otherStoreOrphan)).toBe(true);
    });
  });
});
