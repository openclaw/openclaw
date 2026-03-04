import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { installTestEnv, trackedMkdtemp, trackedMkdtempSync } from "./test-env.js";

describe("test-env tracked temp dirs", () => {
  it("removes tracked temp dirs during cleanup", async () => {
    const env = installTestEnv();
    try {
      const syncDir = trackedMkdtempSync("openclaw-tracked-sync-");
      const asyncDir = await trackedMkdtemp("openclaw-tracked-async-");
      expect(fs.existsSync(syncDir)).toBe(true);
      expect(fs.existsSync(asyncDir)).toBe(true);

      env.cleanup();

      expect(fs.existsSync(syncDir)).toBe(false);
      expect(fs.existsSync(asyncDir)).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
