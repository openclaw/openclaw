import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertCanonicalPathWithinBase, safePathSegmentHashed } from "./install-safe-path.js";

describe("safePathSegmentHashed", () => {
  it("keeps safe names unchanged", () => {
    expect(safePathSegmentHashed("demo-skill")).toBe("demo-skill");
  });

  it("normalizes separators and adds hash suffix", () => {
    const result = safePathSegmentHashed("../../demo/skill");
    expect(result.includes("/")).toBe(false);
    expect(result.includes("\\")).toBe(false);
    expect(result).toMatch(/-[a-f0-9]{10}$/);
  });

  it("hashes long names while staying bounded", () => {
    const long = "a".repeat(100);
    const result = safePathSegmentHashed(long);
    expect(result.length).toBeLessThanOrEqual(61);
    expect(result).toMatch(/-[a-f0-9]{10}$/);
  });
});

describe("assertCanonicalPathWithinBase", () => {
  it("accepts in-base directories", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-safe-"));
    try {
      const candidate = path.join(baseDir, "tools");
      await fs.mkdir(candidate, { recursive: true });
      await expect(
        assertCanonicalPathWithinBase({
          baseDir,
          candidatePath: candidate,
          boundaryLabel: "install directory",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked candidate directories that escape the base",
    async () => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-safe-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-safe-outside-"));
      try {
        const linkDir = path.join(baseDir, "alias");
        await fs.symlink(outsideDir, linkDir);
        await expect(
          assertCanonicalPathWithinBase({
            baseDir,
            candidatePath: linkDir,
            boundaryLabel: "install directory",
          }),
        ).rejects.toThrow(/must stay within install directory/i);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );
});
