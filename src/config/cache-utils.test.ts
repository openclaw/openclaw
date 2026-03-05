import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCacheTtlMs, isCacheEnabled, getFileStatSnapshot } from "./cache-utils.js";

describe("cache-utils", () => {
  describe("resolveCacheTtlMs", () => {
    it("returns default when envValue is undefined", () => {
      expect(resolveCacheTtlMs({ envValue: undefined, defaultTtlMs: 3600000 })).toBe(3600000);
    });

    it("returns default when envValue is empty string", () => {
      expect(resolveCacheTtlMs({ envValue: "", defaultTtlMs: 3600000 })).toBe(3600000);
    });

    it("returns parsed value when valid", () => {
      expect(resolveCacheTtlMs({ envValue: "7200000", defaultTtlMs: 3600000 })).toBe(7200000);
    });

    it("returns zero when envValue is 0", () => {
      expect(resolveCacheTtlMs({ envValue: "0", defaultTtlMs: 3600000 })).toBe(0);
    });

    it("returns default for negative numbers", () => {
      expect(resolveCacheTtlMs({ envValue: "-1", defaultTtlMs: 3600000 })).toBe(3600000);
    });

    it("returns default for invalid strings", () => {
      expect(resolveCacheTtlMs({ envValue: "invalid", defaultTtlMs: 3600000 })).toBe(3600000);
    });

    it("returns default for NaN", () => {
      expect(resolveCacheTtlMs({ envValue: "NaN", defaultTtlMs: 3600000 })).toBe(3600000);
    });

    it("returns default for Infinity", () => {
      expect(resolveCacheTtlMs({ envValue: "Infinity", defaultTtlMs: 3600000 })).toBe(3600000);
    });

    it("parses decimal numbers (floors them)", () => {
      expect(resolveCacheTtlMs({ envValue: "3600.7", defaultTtlMs: 1000 })).toBe(3600);
    });
  });

  describe("isCacheEnabled", () => {
    it("returns true for positive numbers", () => {
      expect(isCacheEnabled(1)).toBe(true);
      expect(isCacheEnabled(3600000)).toBe(true);
    });

    it("returns false for zero", () => {
      expect(isCacheEnabled(0)).toBe(false);
    });

    it("returns false for negative numbers", () => {
      expect(isCacheEnabled(-1)).toBe(false);
      expect(isCacheEnabled(-3600000)).toBe(false);
    });
  });

  describe("getFileStatSnapshot", () => {
    it("returns undefined for non-existent file", () => {
      const result = getFileStatSnapshot("/nonexistent/path/to/file.txt");
      expect(result).toBeUndefined();
    });

    it("returns snapshot for existing file", () => {
      const tmpDir = os.tmpdir();
      const testFile = path.join(tmpDir, `cache-utils-test-${Date.now()}.txt`);

      try {
        fs.writeFileSync(testFile, "test content");
        const result = getFileStatSnapshot(testFile);

        expect(result).toBeDefined();
        expect(result?.mtimeMs).toBeGreaterThan(0);
        expect(result?.sizeBytes).toBe(13); // "test content".length
      } finally {
        try {
          fs.unlinkSync(testFile);
        } catch {
          // ignore cleanup errors
        }
      }
    });

    it("returns correct size for empty file", () => {
      const tmpDir = os.tmpdir();
      const testFile = path.join(tmpDir, `cache-utils-empty-test-${Date.now()}.txt`);

      try {
        fs.writeFileSync(testFile, "");
        const result = getFileStatSnapshot(testFile);

        expect(result).toBeDefined();
        expect(result?.sizeBytes).toBe(0);
      } finally {
        try {
          fs.unlinkSync(testFile);
        } catch {
          // ignore cleanup errors
        }
      }
    });
  });
});
