import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exactWorkspaceEntryExists } from "./root-memory-files.js";

const isRoot = process.getuid && process.getuid() === 0;
const canTestEacces = process.platform !== "win32" && !isRoot;

describe("exactWorkspaceEntryExists", () => {
  it("returns false for a non-existent directory", async () => {
    const result = await exactWorkspaceEntryExists(
      join(tmpdir(), `no-such-dir-${Date.now()}`),
      "MEMORY.md",
    );
    expect(result).toBe(false);
  });

  it("returns true when the entry exists", async () => {
    const dir = join(tmpdir(), `exact-entry-test-exists-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "MEMORY.md"), "");
      await expect(exactWorkspaceEntryExists(dir, "MEMORY.md")).resolves.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the entry does not exist", async () => {
    const dir = join(tmpdir(), `exact-entry-test-missing-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      await expect(exactWorkspaceEntryExists(dir, "MEMORY.md")).resolves.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-throws EACCES when the directory is unreadable", async ({ skip }) => {
    if (!canTestEacces) return skip();
    const dir = join(tmpdir(), `exact-entry-test-eacces-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      await expect(exactWorkspaceEntryExists(dir, "MEMORY.md")).rejects.toThrow();
    } finally {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // restored or already removed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
