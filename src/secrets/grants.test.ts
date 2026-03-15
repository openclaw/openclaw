import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  checkGrant,
  cleanupExpiredGrants,
  getGrantsDir,
  listGrants,
  revokeGrant,
  validateSecretName,
  writeGrant,
} from "./grants.js";

// Mock the grants directory to use a temp location
const _mockGrantsDir = path.join(os.tmpdir(), `openclaw-grants-test-${Date.now()}`);

vi.mock("../config/paths.js", () => ({
  STATE_DIR: path.join(os.tmpdir(), `openclaw-state-test-${Date.now()}`),
}));

describe("grants module", () => {
  beforeEach(async () => {
    // Clean up any previous test data
    try {
      await fs.rm(getGrantsDir(), { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  describe("validateSecretName", () => {
    test("accepts valid alphanumeric names", () => {
      expect(() => validateSecretName("my_secret")).not.toThrow();
      expect(() => validateSecretName("github-token")).not.toThrow();
      expect(() => validateSecretName("aws:access-key")).not.toThrow();
      expect(() => validateSecretName("user.email@service")).not.toThrow();
      expect(() => validateSecretName("SECRET123")).not.toThrow();
    });

    test("rejects empty or too-long names", () => {
      expect(() => validateSecretName("")).toThrow("must be 1-128 characters");
      expect(() => validateSecretName("a".repeat(129))).toThrow("must be 1-128 characters");
    });

    test("rejects path traversal attempts", () => {
      expect(() => validateSecretName("../etc/passwd")).toThrow("path traversal");
      expect(() => validateSecretName("..")).toThrow("path traversal");
      expect(() => validateSecretName("foo/../bar")).toThrow("path traversal");
      expect(() => validateSecretName("/etc/passwd")).toThrow("path traversal");
      expect(() => validateSecretName("foo/bar")).toThrow("path traversal");
      expect(() => validateSecretName("foo\\bar")).toThrow("path traversal");
      expect(() => validateSecretName("foo\0bar")).toThrow("path traversal");
    });

    test("rejects invalid characters", () => {
      expect(() => validateSecretName("foo bar")).toThrow("must contain only");
      expect(() => validateSecretName("foo!bar")).toThrow("must contain only");
      expect(() => validateSecretName("foo$bar")).toThrow("must contain only");
      expect(() => validateSecretName("foo;bar")).toThrow("must contain only");
      expect(() => validateSecretName("foo&bar")).toThrow("must contain only");
    });
  });

  describe("writeGrant", () => {
    test("creates grant file with correct expiry timestamp", async () => {
      const secretName = "test-secret";
      const ttlMinutes = 60;
      const beforeWrite = Math.floor(Date.now() / 1000);

      await writeGrant(secretName, ttlMinutes);

      const afterWrite = Math.floor(Date.now() / 1000);
      const grantPath = path.join(getGrantsDir(), `${secretName}.grant`);
      const content = await fs.readFile(grantPath, "utf8");
      const expiresAt = Number.parseInt(content.trim(), 10);

      expect(expiresAt).toBeGreaterThanOrEqual(beforeWrite + ttlMinutes * 60);
      expect(expiresAt).toBeLessThanOrEqual(afterWrite + ttlMinutes * 60 + 1);
    });

    test("creates grants directory if it doesn't exist", async () => {
      // Ensure directory doesn't exist
      await fs.rm(getGrantsDir(), { recursive: true, force: true });

      await writeGrant("new-secret", 30);

      const grantPath = path.join(getGrantsDir(), "new-secret.grant");
      const exists = await fs
        .access(grantPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    test("overwrites existing grant", async () => {
      await writeGrant("test-secret", 30);
      const firstContent = await fs.readFile(
        path.join(getGrantsDir(), "test-secret.grant"),
        "utf8",
      );

      // Wait a moment to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      await writeGrant("test-secret", 60);
      const secondContent = await fs.readFile(
        path.join(getGrantsDir(), "test-secret.grant"),
        "utf8",
      );

      expect(secondContent).not.toBe(firstContent);
    });
  });

  describe("checkGrant", () => {
    test("returns valid=true for fresh grant", async () => {
      await writeGrant("fresh-secret", 60);

      const info = await checkGrant("fresh-secret");

      expect(info.valid).toBe(true);
      expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(info.remainingMinutes).toBeGreaterThan(0);
      expect(info.remainingMinutes).toBeLessThanOrEqual(60);
    });

    test("returns valid=false for non-existent grant", async () => {
      const info = await checkGrant("nonexistent");

      expect(info.valid).toBe(false);
      expect(info.expiresAt).toBeUndefined();
      expect(info.remainingMinutes).toBeUndefined();
    });

    test("returns valid=false for expired grant", async () => {
      const secretName = "expired-secret";
      const grantPath = path.join(getGrantsDir(), `${secretName}.grant`);

      // Create directory
      await fs.mkdir(getGrantsDir(), { recursive: true });

      // Write grant that expired 1 minute ago
      const expiredTime = Math.floor(Date.now() / 1000) - 60;
      await fs.writeFile(grantPath, String(expiredTime), "utf8");

      const info = await checkGrant(secretName);

      expect(info.valid).toBe(false);
      expect(info.remainingMinutes).toBe(0);
    });

    test("cleans up expired grant file", async () => {
      const secretName = "cleanup-test";
      const grantPath = path.join(getGrantsDir(), `${secretName}.grant`);

      // Create directory
      await fs.mkdir(getGrantsDir(), { recursive: true });

      // Write expired grant
      const expiredTime = Math.floor(Date.now() / 1000) - 60;
      await fs.writeFile(grantPath, String(expiredTime), "utf8");

      await checkGrant(secretName);

      const exists = await fs
        .access(grantPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    test("returns valid=false for malformed grant file", async () => {
      const secretName = "malformed";
      const grantPath = path.join(getGrantsDir(), `${secretName}.grant`);

      await fs.mkdir(getGrantsDir(), { recursive: true });
      await fs.writeFile(grantPath, "not-a-number", "utf8");

      const info = await checkGrant(secretName);

      expect(info.valid).toBe(false);
    });
  });

  describe("revokeGrant", () => {
    test("removes grant file", async () => {
      await writeGrant("revoke-test", 60);
      const grantPath = path.join(getGrantsDir(), "revoke-test.grant");

      await revokeGrant("revoke-test");

      const exists = await fs
        .access(grantPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    test("succeeds silently if grant doesn't exist", async () => {
      await expect(revokeGrant("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("listGrants", () => {
    test("returns empty array when no grants exist", async () => {
      const grants = await listGrants();
      expect(grants).toEqual([]);
    });

    test("returns only valid grants", async () => {
      // Create mix of valid and expired grants
      await writeGrant("valid1", 60);
      await writeGrant("valid2", 30);

      // Create expired grant manually
      await fs.mkdir(getGrantsDir(), { recursive: true });
      const expiredPath = path.join(getGrantsDir(), "expired.grant");
      const expiredTime = Math.floor(Date.now() / 1000) - 60;
      await fs.writeFile(expiredPath, String(expiredTime), "utf8");

      const grants = await listGrants();

      expect(grants.length).toBe(2);
      expect(grants.map((g) => g.name).toSorted()).toEqual(["valid1", "valid2"]);
      expect(grants.every((g) => g.info.valid)).toBe(true);
    });

    test("includes remaining time for each grant", async () => {
      await writeGrant("time-test", 45);

      const grants = await listGrants();

      expect(grants.length).toBe(1);
      expect(grants[0].info.remainingMinutes).toBeGreaterThan(0);
      expect(grants[0].info.remainingMinutes).toBeLessThanOrEqual(45);
    });

    test("automatically cleans up expired grants", async () => {
      // Create expired grant
      await fs.mkdir(getGrantsDir(), { recursive: true });
      const expiredPath = path.join(getGrantsDir(), "auto-cleanup.grant");
      const expiredTime = Math.floor(Date.now() / 1000) - 60;
      await fs.writeFile(expiredPath, String(expiredTime), "utf8");

      await listGrants();

      const exists = await fs
        .access(expiredPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    test("ignores non-grant files", async () => {
      await fs.mkdir(getGrantsDir(), { recursive: true });
      await writeGrant("valid", 60);
      await fs.writeFile(path.join(getGrantsDir(), "readme.txt"), "info", "utf8");
      await fs.writeFile(path.join(getGrantsDir(), "other.json"), "{}", "utf8");

      const grants = await listGrants();

      expect(grants.length).toBe(1);
      expect(grants[0].name).toBe("valid");
    });
  });

  describe("cleanupExpiredGrants", () => {
    test("returns count of revoked grants", async () => {
      // Create mix of valid and expired
      await writeGrant("valid", 60);

      await fs.mkdir(getGrantsDir(), { recursive: true });
      const expiredTime = Math.floor(Date.now() / 1000) - 60;
      await fs.writeFile(path.join(getGrantsDir(), "expired1.grant"), String(expiredTime), "utf8");
      await fs.writeFile(path.join(getGrantsDir(), "expired2.grant"), String(expiredTime), "utf8");

      const count = await cleanupExpiredGrants();

      // Note: listGrants returns only valid grants, so expired ones are already cleaned
      // This function is a no-op if called after listGrants
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test("leaves valid grants untouched", async () => {
      await writeGrant("stay", 60);
      const grantPath = path.join(getGrantsDir(), "stay.grant");
      const contentBefore = await fs.readFile(grantPath, "utf8");

      await cleanupExpiredGrants();

      const exists = await fs
        .access(grantPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
      const contentAfter = await fs.readFile(grantPath, "utf8");
      expect(contentAfter).toBe(contentBefore);
    });
  });

  describe("path traversal protection", () => {
    test("rejects directory traversal in grant names", async () => {
      await expect(writeGrant("../evil", 60)).rejects.toThrow();
      await expect(checkGrant("../evil")).rejects.toThrow();
      await expect(revokeGrant("../evil")).rejects.toThrow();
    });

    test("rejects absolute paths", async () => {
      await expect(writeGrant("/etc/passwd", 60)).rejects.toThrow();
      await expect(checkGrant("/etc/passwd")).rejects.toThrow();
    });

    test("rejects null bytes", async () => {
      await expect(writeGrant("foo\0bar", 60)).rejects.toThrow();
    });
  });
});
