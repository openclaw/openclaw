import { describe, expect, it, vi } from "vitest";
import { rollbackToBackupConfig } from "./rollback.js";

describe("rollbackToBackupConfig", () => {
  it("copies backup to config when backup exists", async () => {
    const mockFs = {
      access: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
    };
    const result = await rollbackToBackupConfig("/test/config.json", mockFs as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.backupPath).toBe("/test/config.json.bak");
    }
    expect(mockFs.copyFile).toHaveBeenCalledWith("/test/config.json.bak", "/test/config.json");
  });

  it("returns error when backup does not exist", async () => {
    const mockFs = {
      access: vi.fn().mockRejectedValue(new Error("ENOENT")),
      copyFile: vi.fn(),
    };
    const result = await rollbackToBackupConfig("/test/config.json", mockFs as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no backup file found");
    }
    expect(mockFs.copyFile).not.toHaveBeenCalled();
  });

  it("returns error when copy fails", async () => {
    const mockFs = {
      access: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockRejectedValue(new Error("EPERM")),
    };
    const result = await rollbackToBackupConfig("/test/config.json", mockFs as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EPERM");
    }
  });
});
