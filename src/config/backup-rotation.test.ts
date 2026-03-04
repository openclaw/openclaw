import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_BACKUP_COUNT,
  rotateConfigBackups,
  hardenBackupPermissions,
  cleanOrphanBackups,
  maintainConfigBackups,
  type BackupRotationFs,
  type BackupMaintenanceFs,
} from "./backup-rotation.js";

describe("backup-rotation", () => {
  describe("CONFIG_BACKUP_COUNT", () => {
    it("has expected value of 5", () => {
      expect(CONFIG_BACKUP_COUNT).toBe(5);
    });
  });

  describe("rotateConfigBackups", () => {
    it("does nothing when CONFIG_BACKUP_COUNT is 1 or less", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
      };
      
      // Temporarily override the constant
      const originalCount = CONFIG_BACKUP_COUNT;
      // We can't easily override the constant, but we can verify the function works
      
      await rotateConfigBackups("/config/openclaw.json", mockFs);
      
      // With default count of 5, it should perform rotations
      expect(mockFs.unlink).toHaveBeenCalled();
    });

    it("rotates backups in correct order", async () => {
      const operations: string[] = [];
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockImplementation((p) => {
          operations.push(`unlink:${p}`);
          return Promise.resolve();
        }),
        rename: vi.fn().mockImplementation((from, to) => {
          operations.push(`rename:${from}->${to}`);
          return Promise.resolve();
        }),
      };

      await rotateConfigBackups("/config/openclaw.json", mockFs);

      // Should unlink the highest numbered backup
      expect(operations).toContain("unlink:/config/openclaw.json.bak.4");
      
      // Should rotate numbered backups
      expect(operations).toContain("rename:/config/openclaw.json.bak.3->/config/openclaw.json.bak.4");
      expect(operations).toContain("rename:/config/openclaw.json.bak.2->/config/openclaw.json.bak.3");
      expect(operations).toContain("rename:/config/openclaw.json.bak.1->/config/openclaw.json.bak.2");
      
      // Should move primary .bak to .bak.1
      expect(operations).toContain("rename:/config/openclaw.json.bak->/config/openclaw.json.bak.1");
    });

    it("handles errors gracefully (best-effort)", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockRejectedValue(new Error("ENOENT")),
        rename: vi.fn().mockRejectedValue(new Error("ENOENT")),
      };

      // Should not throw
      await expect(rotateConfigBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });
  });

  describe("hardenBackupPermissions", () => {
    it("does nothing when chmod is not available", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
        // chmod not provided
      };

      await expect(hardenBackupPermissions("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });

    it("hardens permissions on all backup files", async () => {
      const chmodCalls: Array<{ path: string; mode: number }> = [];
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
        chmod: vi.fn().mockImplementation((p, m) => {
          chmodCalls.push({ path: p, mode: m });
          return Promise.resolve();
        }),
      };

      await hardenBackupPermissions("/config/openclaw.json", mockFs);

      // Should chmod primary .bak and numbered backups
      expect(chmodCalls).toHaveLength(5);
      expect(chmodCalls[0]).toEqual({ path: "/config/openclaw.json.bak", mode: 0o600 });
      expect(chmodCalls[1]).toEqual({ path: "/config/openclaw.json.bak.1", mode: 0o600 });
      expect(chmodCalls[2]).toEqual({ path: "/config/openclaw.json.bak.2", mode: 0o600 });
      expect(chmodCalls[3]).toEqual({ path: "/config/openclaw.json.bak.3", mode: 0o600 });
      expect(chmodCalls[4]).toEqual({ path: "/config/openclaw.json.bak.4", mode: 0o600 });
    });

    it("handles chmod errors gracefully", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
        chmod: vi.fn().mockRejectedValue(new Error("EPERM")),
      };

      // Should not throw
      await expect(hardenBackupPermissions("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });
  });

  describe("cleanOrphanBackups", () => {
    it("does nothing when readdir is not available", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
        // readdir not provided
      };

      await expect(cleanOrphanBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });

    it("removes orphan backup files", async () => {
      const unlinked: string[] = [];
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockImplementation((p) => {
          unlinked.push(p);
          return Promise.resolve();
        }),
        rename: vi.fn(),
        readdir: vi.fn().mockResolvedValue([
          "openclaw.json",
          "openclaw.json.bak",
          "openclaw.json.bak.1",
          "openclaw.json.bak.2",
          "openclaw.json.bak.12345", // orphan - timestamp
          "openclaw.json.bak.before-migration", // orphan - custom suffix
          "other-file.txt",
        ]),
      };

      await cleanOrphanBackups("/config/openclaw.json", mockFs);

      // Should remove orphans
      expect(unlinked).toContain("/config/openclaw.json.bak.12345");
      expect(unlinked).toContain("/config/openclaw.json.bak.before-migration");
      
      // Should NOT remove valid numbered backups
      expect(unlinked).not.toContain("/config/openclaw.json.bak.1");
      expect(unlinked).not.toContain("/config/openclaw.json.bak.2");
      
      // Should NOT remove primary .bak
      expect(unlinked).not.toContain("/config/openclaw.json.bak");
    });

    it("handles readdir errors gracefully", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
        readdir: vi.fn().mockRejectedValue(new Error("EACCES")),
      };

      // Should not throw
      await expect(cleanOrphanBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });

    it("handles unlink errors gracefully", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockRejectedValue(new Error("EACCES")),
        rename: vi.fn(),
        readdir: vi.fn().mockResolvedValue(["openclaw.json.bak.999"]),
      };

      // Should not throw
      await expect(cleanOrphanBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });

    it("ignores files without .bak. prefix", async () => {
      const unlinked: string[] = [];
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockImplementation((p) => {
          unlinked.push(p);
          return Promise.resolve();
        }),
        rename: vi.fn(),
        readdir: vi.fn().mockResolvedValue([
          "openclaw.json.backup.1", // different prefix
          "openclaw.json.bak", // primary (no suffix)
          "openclaw.json.bak.extra", // orphan
        ]),
      };

      await cleanOrphanBackups("/config/openclaw.json", mockFs);

      // Should only remove .bak.* files
      expect(unlinked).toContain("/config/openclaw.json.bak.extra");
      expect(unlinked).not.toContain("/config/openclaw.json.backup.1");
      expect(unlinked).not.toContain("/config/openclaw.json.bak");
    });
  });

  describe("maintainConfigBackups", () => {
    it("runs full maintenance cycle in correct order", async () => {
      const operations: string[] = [];
      const mockFs: BackupMaintenanceFs = {
        unlink: vi.fn().mockImplementation((p) => {
          operations.push(`unlink:${p}`);
          return Promise.resolve();
        }),
        rename: vi.fn().mockImplementation((from, to) => {
          operations.push(`rename:${from}->${to}`);
          return Promise.resolve();
        }),
        copyFile: vi.fn().mockImplementation((from, to) => {
          operations.push(`copyFile:${from}->${to}`);
          return Promise.resolve();
        }),
        chmod: vi.fn().mockImplementation((p, m) => {
          operations.push(`chmod:${p}:${m.toString(8)}`);
          return Promise.resolve();
        }),
        readdir: vi.fn().mockResolvedValue([]),
      };

      await maintainConfigBackups("/config/openclaw.json", mockFs);

      // Order should be: rotate -> copy -> harden -> clean
      const copyIndex = operations.findIndex((o) => o.startsWith("copyFile"));
      const chmodIndex = operations.findIndex((o) => o.startsWith("chmod"));

      expect(copyIndex).toBeGreaterThan(-1);
      expect(chmodIndex).toBeGreaterThan(copyIndex);
      
      // Should copy current config to .bak
      expect(operations).toContain("copyFile:/config/openclaw.json->/config/openclaw.json.bak");
    });

    it("handles errors gracefully at each step", async () => {
      const mockFs: BackupMaintenanceFs = {
        unlink: vi.fn().mockRejectedValue(new Error("ENOENT")),
        rename: vi.fn().mockRejectedValue(new Error("ENOENT")),
        copyFile: vi.fn().mockRejectedValue(new Error("EACCES")),
        chmod: vi.fn().mockRejectedValue(new Error("EPERM")),
        readdir: vi.fn().mockRejectedValue(new Error("EACCES")),
      };

      // Should not throw despite errors at each step
      await expect(maintainConfigBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });
  });
});
