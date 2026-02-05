import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatOctal,
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  isGroupReadable,
  isGroupWritable,
  isWorldReadable,
  isWorldWritable,
  modeBits,
  safeStat,
  type PermissionCheck,
} from "./audit-fs.js";

describe("audit-fs", () => {
  describe("modeBits", () => {
    it("extracts lower 9 bits from mode", () => {
      // 0o100755 (regular file with 755 permissions) → 0o755
      expect(modeBits(0o100755)).toBe(0o755);
      // 0o40700 (directory with 700 permissions) → 0o700
      expect(modeBits(0o40700)).toBe(0o700);
      // 0o100644 (regular file with 644 permissions) → 0o644
      expect(modeBits(0o100644)).toBe(0o644);
    });

    it("handles pure permission bits", () => {
      expect(modeBits(0o755)).toBe(0o755);
      expect(modeBits(0o600)).toBe(0o600);
      expect(modeBits(0o777)).toBe(0o777);
    });

    it("returns null for null input", () => {
      expect(modeBits(null)).toBeNull();
    });
  });

  describe("formatOctal", () => {
    it("formats bits as 3-digit octal string", () => {
      expect(formatOctal(0o755)).toBe("755");
      expect(formatOctal(0o644)).toBe("644");
      expect(formatOctal(0o700)).toBe("700");
    });

    it("pads single and double digit octals", () => {
      expect(formatOctal(0o7)).toBe("007");
      expect(formatOctal(0o77)).toBe("077");
    });

    it("returns 'unknown' for null input", () => {
      expect(formatOctal(null)).toBe("unknown");
    });
  });

  describe("isWorldWritable", () => {
    it("returns true when world write bit is set", () => {
      expect(isWorldWritable(0o777)).toBe(true);
      expect(isWorldWritable(0o666)).toBe(true);
      expect(isWorldWritable(0o002)).toBe(true);
    });

    it("returns false when world write bit is not set", () => {
      expect(isWorldWritable(0o755)).toBe(false);
      expect(isWorldWritable(0o644)).toBe(false);
      expect(isWorldWritable(0o700)).toBe(false);
    });

    it("returns false for null input", () => {
      expect(isWorldWritable(null)).toBe(false);
    });
  });

  describe("isGroupWritable", () => {
    it("returns true when group write bit is set", () => {
      expect(isGroupWritable(0o777)).toBe(true);
      expect(isGroupWritable(0o770)).toBe(true);
      expect(isGroupWritable(0o020)).toBe(true);
    });

    it("returns false when group write bit is not set", () => {
      expect(isGroupWritable(0o755)).toBe(false);
      expect(isGroupWritable(0o700)).toBe(false);
      expect(isGroupWritable(0o644)).toBe(false);
    });

    it("returns false for null input", () => {
      expect(isGroupWritable(null)).toBe(false);
    });
  });

  describe("isWorldReadable", () => {
    it("returns true when world read bit is set", () => {
      expect(isWorldReadable(0o755)).toBe(true);
      expect(isWorldReadable(0o644)).toBe(true);
      expect(isWorldReadable(0o004)).toBe(true);
    });

    it("returns false when world read bit is not set", () => {
      expect(isWorldReadable(0o700)).toBe(false);
      expect(isWorldReadable(0o600)).toBe(false);
      expect(isWorldReadable(0o770)).toBe(false);
    });

    it("returns false for null input", () => {
      expect(isWorldReadable(null)).toBe(false);
    });
  });

  describe("isGroupReadable", () => {
    it("returns true when group read bit is set", () => {
      expect(isGroupReadable(0o755)).toBe(true);
      expect(isGroupReadable(0o750)).toBe(true);
      expect(isGroupReadable(0o040)).toBe(true);
    });

    it("returns false when group read bit is not set", () => {
      expect(isGroupReadable(0o700)).toBe(false);
      expect(isGroupReadable(0o600)).toBe(false);
      expect(isGroupReadable(0o704)).toBe(false);
    });

    it("returns false for null input", () => {
      expect(isGroupReadable(null)).toBe(false);
    });
  });

  describe("formatPermissionDetail", () => {
    it("formats POSIX permissions", () => {
      const perms: PermissionCheck = {
        ok: true,
        isSymlink: false,
        isDir: false,
        mode: 0o100644,
        bits: 0o644,
        source: "posix",
        worldWritable: false,
        groupWritable: false,
        worldReadable: true,
        groupReadable: true,
      };
      expect(formatPermissionDetail("/path/to/file", perms)).toBe("/path/to/file mode=644");
    });

    it("formats Windows ACL permissions", () => {
      const perms: PermissionCheck = {
        ok: true,
        isSymlink: false,
        isDir: false,
        mode: 0o100644,
        bits: 0o644,
        source: "windows-acl",
        worldWritable: false,
        groupWritable: false,
        worldReadable: false,
        groupReadable: false,
        aclSummary: "BUILTIN\\Users:R",
      };
      expect(formatPermissionDetail("C:\\path\\to\\file", perms)).toBe(
        "C:\\path\\to\\file acl=BUILTIN\\Users:R",
      );
    });

    it("handles missing ACL summary", () => {
      const perms: PermissionCheck = {
        ok: true,
        isSymlink: false,
        isDir: false,
        mode: 0o100644,
        bits: 0o644,
        source: "windows-acl",
        worldWritable: false,
        groupWritable: false,
        worldReadable: false,
        groupReadable: false,
      };
      expect(formatPermissionDetail("C:\\path\\to\\file", perms)).toBe(
        "C:\\path\\to\\file acl=unknown",
      );
    });
  });

  describe("formatPermissionRemediation", () => {
    it("generates chmod command for POSIX", () => {
      const perms: PermissionCheck = {
        ok: true,
        isSymlink: false,
        isDir: false,
        mode: 0o100777,
        bits: 0o777,
        source: "posix",
        worldWritable: true,
        groupWritable: true,
        worldReadable: true,
        groupReadable: true,
      };
      const result = formatPermissionRemediation({
        targetPath: "/path/to/file",
        perms,
        isDir: false,
        posixMode: 0o600,
      });
      expect(result).toBe("chmod 600 /path/to/file");
    });

    it("generates icacls command for Windows", () => {
      const perms: PermissionCheck = {
        ok: true,
        isSymlink: false,
        isDir: false,
        mode: null,
        bits: null,
        source: "windows-acl",
        worldWritable: true,
        groupWritable: false,
        worldReadable: true,
        groupReadable: false,
      };
      const result = formatPermissionRemediation({
        targetPath: "C:\\path\\to\\file",
        perms,
        isDir: false,
        posixMode: 0o600,
        env: { USERNAME: "TestUser" },
      });
      expect(result).toContain("icacls");
      expect(result).toContain("C:\\path\\to\\file");
    });
  });

  describe("safeStat", () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-fs-test-"));
      tempFile = path.join(tempDir, "testfile");
      await fs.writeFile(tempFile, "test content");
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
    });

    it("returns file info for existing file", async () => {
      const result = await safeStat(tempFile);
      expect(result.ok).toBe(true);
      expect(result.isSymlink).toBe(false);
      expect(result.isDir).toBe(false);
      expect(result.mode).not.toBeNull();
      expect(result.error).toBeUndefined();
    });

    it("returns directory info for existing directory", async () => {
      const result = await safeStat(tempDir);
      expect(result.ok).toBe(true);
      expect(result.isSymlink).toBe(false);
      expect(result.isDir).toBe(true);
      expect(result.mode).not.toBeNull();
    });

    it("returns error for non-existent path", async () => {
      const result = await safeStat("/nonexistent/path/that/does/not/exist");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.mode).toBeNull();
    });

    it("detects symlinks", async () => {
      const symlinkPath = path.join(tempDir, "symlink");
      await fs.symlink(tempFile, symlinkPath);
      const result = await safeStat(symlinkPath);
      expect(result.ok).toBe(true);
      expect(result.isSymlink).toBe(true);
    });
  });

  describe("inspectPathPermissions", () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-fs-test-"));
      tempFile = path.join(tempDir, "testfile");
      await fs.writeFile(tempFile, "test content");
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
    });

    it("returns POSIX permissions on non-Windows", async () => {
      const result = await inspectPathPermissions(tempFile, { platform: "darwin" });
      expect(result.ok).toBe(true);
      expect(result.source).toBe("posix");
      expect(result.bits).not.toBeNull();
    });

    it("returns error info for non-existent path", async () => {
      const result = await inspectPathPermissions("/nonexistent/path");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.source).toBe("unknown");
    });

    it("detects world-writable files on POSIX", async () => {
      // Set world-writable permissions
      await fs.chmod(tempFile, 0o666);
      const result = await inspectPathPermissions(tempFile, { platform: "darwin" });
      expect(result.ok).toBe(true);
      expect(result.worldWritable).toBe(true);
    });

    it("detects restricted files on POSIX", async () => {
      // Set restricted permissions
      await fs.chmod(tempFile, 0o600);
      const result = await inspectPathPermissions(tempFile, { platform: "darwin" });
      expect(result.ok).toBe(true);
      expect(result.worldWritable).toBe(false);
      expect(result.groupWritable).toBe(false);
      expect(result.worldReadable).toBe(false);
      expect(result.groupReadable).toBe(false);
    });

    it("uses Windows ACL inspection on win32 platform", async () => {
      // Mock exec function for Windows ACL inspection
      const mockExec = vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "",
      });

      const result = await inspectPathPermissions(tempFile, {
        platform: "win32",
        exec: mockExec,
      });

      // On win32, it should attempt to use Windows ACL
      expect(result.ok).toBe(true);
      // Without real icacls output, it falls back to unknown/error state
    });
  });
});
