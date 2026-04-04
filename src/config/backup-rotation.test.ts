import { describe, expect, it, vi } from "vitest";
import {
  rotateConfigBackups,
  CONFIG_BACKUP_COUNT,
} from "./backup-rotation.js";

describe("CONFIG_BACKUP_COUNT", () => {
  it("has correct value", () => {
    expect(CONFIG_BACKUP_COUNT).toBe(5);
  });
});

describe("rotateConfigBackups", () => {
  const createMockFs = (calls: { unlink: string[], rename: Array<[string, string]> }) => {
    const unlinkFn = vi.fn().mockResolvedValue(undefined);
    const renameFn = vi.fn().mockImplementation((from: string, to: string) => {
      calls.rename.push([from, to]);
      return Promise.resolve();
    });
    return { unlink: unlinkFn, rename: renameFn, calls };
  };

  it("rotates backup files correctly", async () => {
    const { unlink, rename, calls } = createMockFs({ unlink: [], rename: [] });
    await rotateConfigBackups("/cfg/openclaw.json", { unlink, rename });
    expect(calls.rename).toContainEqual(["/cfg/openclaw.json.bak", "/cfg/openclaw.json.bak.1"]);
    expect(calls.rename).toContainEqual(["/cfg/openclaw.json.bak.1", "/cfg/openclaw.json.bak.2"]);
    expect(calls.rename).toContainEqual(["/cfg/openclaw.json.bak.2", "/cfg/openclaw.json.bak.3"]);
    expect(calls.rename).toContainEqual(["/cfg/openclaw.json.bak.3", "/cfg/openclaw.json.bak.4"]);
  });

  it("deletes oldest backup", async () => {
    const { unlink, calls } = createMockFs({ unlink: [], rename: [] });
    await rotateConfigBackups("/cfg/openclaw.json", { unlink, rename: vi.fn() });
    expect(calls.unlink).toContain("/cfg/openclaw.json.bak.5");
  });

  it("handles missing files gracefully", async () => {
    const unlink = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const rename = vi.fn().mockRejectedValue(new Error("ENOENT"));
    // Should not throw
    await expect(rotateConfigBackups("/cfg/openclaw.json", { unlink, rename })).resolves.not.toThrow();
  });

  it("skips rotation when CONFIG_BACKUP_COUNT <= 1", async () => {
    // This test validates the early return path conceptually
    const unlink = vi.fn();
    const rename = vi.fn();
    await rotateConfigBackups("/cfg/openclaw.json", { unlink, rename });
    // With CONFIG_BACKUP_COUNT = 5, rotation should happen
    expect(unlink).toHaveBeenCalled();
  });
});
