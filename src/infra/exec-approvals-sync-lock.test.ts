import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  normalizeExecApprovals,
  resetExecApprovalsSyncLockStateForTest,
  saveExecApprovals,
  updateExecApprovals,
} from "./exec-approvals.js";

const tempDirs: string[] = [];
const testEnvSnapshot = captureEnv(["OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

beforeEach(() => {
  resetExecApprovalsSyncLockStateForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  testEnvSnapshot.restore();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function setupStateDir(): { dir: string; statePath: string; lockPath: string } {
  const dir = makeTempDir();
  tempDirs.push(dir);
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  deleteTestEnvValue("OPENCLAW_HOME");
  const statePath = path.join(dir, "exec-approvals.json");
  const lockPath = `${statePath}.lock`;
  return { dir, statePath, lockPath };
}

describe("exec approvals sync lock", () => {
  it("removes lock sidecar after save completes", () => {
    const { statePath, lockPath } = setupStateDir();
    const file = normalizeExecApprovals({
      version: 1,
      entries: [],
      host: "gateway",
      security: "deny",
    });
    saveExecApprovals(file);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("uses nonce-based ownership instead of inode/device check", () => {
    const { statePath, lockPath } = setupStateDir();
    const origClose = fs.closeSync;
    let lockContent: string | null = null;
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((...args: unknown[]) => {
      const fd = args[0] as number;
      if (fs.existsSync(lockPath)) {
        try {
          lockContent = fs.readFileSync(lockPath, "utf8");
        } catch {}
      }
      const result = origClose(fd);
      return result;
    });
    const file = normalizeExecApprovals({
      version: 1,
      entries: [],
      host: "gateway",
      security: "deny",
    });
    saveExecApprovals(file);
    closeSpy.mockRestore();
    let nonceSeen = false;
    if (lockContent) {
      const parsed = JSON.parse(lockContent);
      nonceSeen = typeof parsed.nonce === "string" && parsed.nonce.length > 0;
    }
    expect(nonceSeen).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(true);
  });
});

describe("exec approvals async lock", () => {
  // The gateway's real exec-approval traffic goes through updateExecApprovals,
  // not saveExecApprovals. It must use the same nonce-based lock as the sync
  // path instead of the external fs-safe sidecar lock, whose release compares
  // an fd-based fstat against a path-based lstat and can silently skip the
  // unlink on VirtioFS bind mounts (openclaw/openclaw#106777).
  it("removes lock sidecar after an async update completes", async () => {
    const { statePath, lockPath } = setupStateDir();
    const file = normalizeExecApprovals({
      version: 1,
      entries: [],
      host: "gateway",
      security: "deny",
    });
    await updateExecApprovals({ update: () => file });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("uses nonce-based ownership for async updates too", async () => {
    const { statePath, lockPath } = setupStateDir();
    const origClose = fs.closeSync;
    let lockContent: string | null = null;
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((...args: unknown[]) => {
      const fd = args[0] as number;
      if (fs.existsSync(lockPath)) {
        try {
          lockContent = fs.readFileSync(lockPath, "utf8");
        } catch {}
      }
      const result = origClose(fd);
      return result;
    });
    const file = normalizeExecApprovals({
      version: 1,
      entries: [],
      host: "gateway",
      security: "deny",
    });
    await updateExecApprovals({ update: () => file });
    closeSpy.mockRestore();
    let nonceSeen = false;
    if (lockContent) {
      const parsed = JSON.parse(lockContent);
      nonceSeen = typeof parsed.nonce === "string" && parsed.nonce.length > 0;
    }
    expect(nonceSeen).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("allows a sync lock and an async lock on the same path to interleave without deadlocking", async () => {
    const { statePath, lockPath } = setupStateDir();
    const file = normalizeExecApprovals({
      version: 1,
      entries: [],
      host: "gateway",
      security: "deny",
    });
    saveExecApprovals(file);
    await updateExecApprovals({ update: () => file });
    saveExecApprovals(file);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(true);
  });
});
