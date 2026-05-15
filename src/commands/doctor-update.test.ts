import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectOpenClawGitCheckout } from "./doctor-update.js";

describe("doctor-update git checkout detection", () => {
  it("detects git checkout through a symlink", async () => {
    const realRoot = path.resolve(import.meta.dirname, "../..");
    const linkPath = path.join(os.tmpdir(), `openclaw-symlink-test-${Date.now()}`);

    try {
      fs.symlinkSync(realRoot, linkPath, "junction");
      const result = await detectOpenClawGitCheckout(linkPath);
      expect(result).toBe("git");
    } finally {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        // cleanup best-effort
      }
    }
  });

  it("detects git checkout with direct path", async () => {
    const realRoot = path.resolve(import.meta.dirname, "../..");
    const result = await detectOpenClawGitCheckout(realRoot);
    expect(result).toBe("git");
  });

  it("returns not-git for non-git directory", async () => {
    const result = await detectOpenClawGitCheckout(os.tmpdir());
    expect(result).toBe("not-git");
  });
});
