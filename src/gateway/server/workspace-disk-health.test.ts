// Workspace disk health probe tests cover the probe lifecycle and error handling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceDiskHealthProbe } from "./workspace-disk-health.js";

const dirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-disk-health-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("createWorkspaceDiskHealthProbe", () => {
  it("reports ok on a writable directory", () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-health-test-"));
    dirs.push(probeDir);
    const probe = createWorkspaceDiskHealthProbe({ probeDir, ttlMs: 0 });
    expect(probe()).toEqual({ ok: true });
  });

  it("caches ok result within TTL", () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-health-test-"));
    dirs.push(probeDir);
    const probe = createWorkspaceDiskHealthProbe({ probeDir, ttlMs: 60_000 });
    const first = probe();
    // Remove the probe dir; with a long TTL the cached result should still be ok.
    fs.rmSync(probeDir, { recursive: true, force: true });
    const second = probe();
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
  });

  it("evicts cache after TTL expires", () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-health-test-"));
    dirs.push(probeDir);
    const probe = createWorkspaceDiskHealthProbe({ probeDir, ttlMs: 0 });
    expect(probe()).toEqual({ ok: true });
    // With TTL=0, every call re-probes.
    fs.rmSync(probeDir, { recursive: true, force: true });
    // The probe should now fail since the directory is gone.
    const result = probe();
    expect(result.ok).toBe(false);
  });
});
