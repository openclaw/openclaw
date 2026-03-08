import path from "node:path";
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
    it("rotates backups when CONFIG_BACKUP_COUNT > 1", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
      };

      await rotateConfigBackups("/config/openclaw.json", mockFs);

      expect(mockFs.unlink).toHaveBeenCalled();
      expect(mockFs.rename).toHaveBeenCalled();
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

      expect(operations).toContain("unlink:/config/openclaw.json.bak.4");
      expect(operations).toContain(
        "rename:/config/openclaw.json.bak.3->/config/openclaw.json.bak.4",
      );
      expect(operations).toContain(
        "rename:/config/openclaw.json.bak.2->/config/openclaw.json.bak.3",
      );
      expect(operations).toContain(
        "rename:/config/openclaw.json.bak.1->/config/openclaw.json.bak.2",
      );
      expect(operations).toContain("rename:/config/openclaw.json.bak->/config/openclaw.json.bak.1");
    });

    it("handles errors gracefully (best-effort)", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockRejectedValue(new Error("ENOENT")),
        rename: vi.fn().mockRejectedValue(new Error("ENOENT")),
      };

      await expect(rotateConfigBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });
  });

  describe("hardenBackupPermissions", () => {
    it("does nothing when chmod is not available", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
      };

      await expect(
        hardenBackupPermissions("/config/openclaw.json", mockFs),
      ).resolves.toBeUndefined();
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

      await expect(
        hardenBackupPermissions("/config/openclaw.json", mockFs),
      ).resolves.toBeUndefined();
    });
  });

  describe("cleanOrphanBackups", () => {
    it("does nothing when readdir is not available", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
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
        readdir: vi
          .fn()
          .mockResolvedValue([
            "openclaw.json",
            "openclaw.json.bak",
            "openclaw.json.bak.1",
            "openclaw.json.bak.2",
            "openclaw.json.bak.12345",
            "openclaw.json.bak.before-migration",
            "other-file.txt",
          ]),
      };

      const configPath = "/config/openclaw.json";
      const baseDir = path.dirname(configPath);

      await cleanOrphanBackups(configPath, mockFs);

      expect(unlinked).toContain(path.join(baseDir, "openclaw.json.bak.12345"));
      expect(unlinked).toContain(path.join(baseDir, "openclaw.json.bak.before-migration"));
      expect(unlinked).not.toContain(path.join(baseDir, "openclaw.json.bak.1"));
      expect(unlinked).not.toContain(path.join(baseDir, "openclaw.json.bak.2"));
      expect(unlinked).not.toContain(path.join(baseDir, "openclaw.json.bak"));
    });

    it("handles readdir errors gracefully", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn(),
        rename: vi.fn(),
        readdir: vi.fn().mockRejectedValue(new Error("EACCES")),
      };

      await expect(cleanOrphanBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });

    it("handles unlink errors gracefully", async () => {
      const mockFs: BackupRotationFs = {
        unlink: vi.fn().mockRejectedValue(new Error("EACCES")),
        rename: vi.fn(),
        readdir: vi.fn().mockResolvedValue(["openclaw.json.bak.999"]),
      };

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
        readdir: vi
          .fn()
          .mockResolvedValue([
            "openclaw.json.backup.1",
            "openclaw.json.bak",
            "openclaw.json.bak.extra",
          ]),
      };

      const configPath = "/config/openclaw.json";
      const baseDir = path.dirname(configPath);

      await cleanOrphanBackups(configPath, mockFs);

      expect(unlinked).toContain(path.join(baseDir, "openclaw.json.bak.extra"));
      expect(unlinked).not.toContain(path.join(baseDir, "openclaw.json.backup.1"));
      expect(unlinked).not.toContain(path.join(baseDir, "openclaw.json.bak"));
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

      const copyIndex = operations.findIndex((o) => o.startsWith("copyFile"));
      const chmodIndex = operations.findIndex((o) => o.startsWith("chmod"));

      expect(copyIndex).toBeGreaterThan(-1);
      expect(chmodIndex).toBeGreaterThan(copyIndex);
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

      await expect(maintainConfigBackups("/config/openclaw.json", mockFs)).resolves.toBeUndefined();
    });
  });
});
