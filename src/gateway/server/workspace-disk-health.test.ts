// Workspace disk health probe tests cover the probe lifecycle and error handling.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceDiskHealthProbe } from "./workspace-disk-health.js";

const dirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-health-"));
  dirs.push(dir);
  return dir;
}

function removeDir(dir: string): void {
  try {
    execSync(`rm -rf -- "${dir}"`, { stdio: "ignore" });
  } catch {
    // Ignore cleanup errors.
  }
}

afterEach(() => {
  for (const d of dirs) {
    removeDir(d);
  }
  dirs.length = 0;
});

describe("createWorkspaceDiskHealthProbe", () => {
  it("reports ok on a writable directory", () => {
    const probeDir = makeTmpDir();
    const probe = createWorkspaceDiskHealthProbe({ probeDir, ttlMs: 0 });
    expect(probe()).toEqual({ ok: true });
  });

  it("caches ok result within TTL", () => {
    const probeDir = makeTmpDir();
    const probe = createWorkspaceDiskHealthProbe({ probeDir, ttlMs: 60_000 });
    const first = probe();
    // Remove the probe dir; with a long TTL the cached result should still be ok.
    removeDir(probeDir);
    const second = probe();
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
  });

  it("evicts cache after TTL expires", () => {
    const probeDir = makeTmpDir();
    const probe = createWorkspaceDiskHealthProbe({ probeDir, ttlMs: 0 });
    expect(probe()).toEqual({ ok: true });
    // With TTL=0, every call re-probes.
    removeDir(probeDir);
    // The probe should now fail since the directory is gone.
    const result = probe();
    expect(result.ok).toBe(false);
  });
});
