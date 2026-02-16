import { afterEach, describe, expect, it, vi } from "vitest";
import { detectBinary } from "./onboard-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectBinary", () => {
  it("returns false for empty name", async () => {
    expect(await detectBinary("")).toBe(false);
    expect(await detectBinary("  ")).toBe(false);
  });

  it("finds a standard binary (ls) with any PATH", async () => {
    expect(await detectBinary("ls")).toBe(true);
  });

  it("returns false for a nonexistent binary", async () => {
    expect(await detectBinary("__nonexistent_binary_xyz__")).toBe(false);
  });

  it("finds an absolute path binary", async () => {
    expect(await detectBinary("/usr/bin/env")).toBe(true);
  });

  it("returns false for a missing absolute path", async () => {
    expect(await detectBinary("/usr/bin/__nonexistent__")).toBe(false);
  });

  it("finds Homebrew binaries with restricted PATH on macOS (#17890)", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    // Skip if brew is not installed on this machine at all
    const hasBrew = await detectBinary("brew");
    if (!hasBrew) {
      return;
    }
    const originalPath = process.env.PATH;
    // Simulate macOS app's restricted PATH
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    try {
      const found = await detectBinary("brew");
      expect(found).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
