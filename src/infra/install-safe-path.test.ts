import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
  unscopedPackageName,
} from "./install-safe-path.js";

describe("unscopedPackageName", () => {
  it.each([
    { value: "@openclaw/matrix", expected: "matrix" },
    { value: " matrix ", expected: "matrix" },
    { value: "", expected: "" },
  ])("normalizes package names for %j", ({ value, expected }) => {
    expect(unscopedPackageName(value)).toBe(expected);
  });
});

describe("safeDirName", () => {
  it.each([
    { value: " matrix ", expected: "matrix" },
    { value: "../matrix/plugin", expected: "..__matrix__plugin" },
    { value: "dir\\plugin", expected: "dir__plugin" },
  ])("normalizes install dir names for %j", ({ value, expected }) => {
    expect(safeDirName(value)).toBe(expected);
  });
});

describe("safePathSegmentHashed", () => {
  it("keeps safe names unchanged", () => {
    expect(safePathSegmentHashed("demo-skill")).toBe("demo-skill");
  });

  it("falls back to a hashed skill name for empty or dot-like segments", () => {
    expect(safePathSegmentHashed("   ")).toMatch(/^skill-[a-f0-9]{10}$/);
    expect(safePathSegmentHashed(".")).toMatch(/^skill-[a-f0-9]{10}$/);
    expect(safePathSegmentHashed("..")).toMatch(/^skill-[a-f0-9]{10}$/);
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

describe("resolveSafeInstallDir", () => {
  it("resolves install dirs under the base directory", () => {
    expect(
      resolveSafeInstallDir({
        baseDir: "/tmp/plugins",
        id: "@openclaw/matrix",
        invalidNameMessage: "invalid plugin name",
      }),
    ).toEqual({
      ok: true,
      path: path.join("/tmp/plugins", "@openclaw__matrix"),
    });
  });

  it("rejects ids that resolve to the base directory itself", () => {
    expect(
      resolveSafeInstallDir({
        baseDir: "/tmp/plugins",
        id: "   ",
        invalidNameMessage: "invalid plugin name",
      }),
    ).toEqual({
      ok: false,
      error: "invalid plugin name",
    });
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

  it("accepts missing candidate paths when their parent stays in base", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-safe-"));
    try {
      const candidate = path.join(baseDir, "tools", "plugin");
      await fs.mkdir(path.dirname(candidate), { recursive: true });
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

  it("rejects non-directory base paths", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-safe-"));
    const baseFile = path.join(baseDir, "not-a-dir");
    await fs.writeFile(baseFile, "nope", "utf-8");
    try {
      await expect(
        assertCanonicalPathWithinBase({
          baseDir: baseFile,
          candidatePath: path.join(baseFile, "child"),
          boundaryLabel: "install directory",
        }),
      ).rejects.toThrow(/base directory must be a real directory/i);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("rejects non-directory candidate paths inside the base", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-safe-"));
    const candidate = path.join(baseDir, "file.txt");
    await fs.writeFile(candidate, "nope", "utf-8");
    try {
      await expect(
        assertCanonicalPathWithinBase({
          baseDir,
          candidatePath: candidate,
          boundaryLabel: "install directory",
        }),
      ).rejects.toThrow(/must stay within install directory/i);
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

  it.runIf(process.platform !== "win32")("rejects symlinked base directories", async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-safe-"));
    const realBaseDir = path.join(parentDir, "real-base");
    const symlinkBaseDir = path.join(parentDir, "base-link");
    await fs.mkdir(realBaseDir, { recursive: true });
    await fs.symlink(realBaseDir, symlinkBaseDir);
    try {
      await expect(
        assertCanonicalPathWithinBase({
          baseDir: symlinkBaseDir,
          candidatePath: path.join(symlinkBaseDir, "tool"),
          boundaryLabel: "install directory",
        }),
      ).rejects.toThrow(/base directory must be a real directory/i);
    } finally {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  });
});
