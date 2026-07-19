import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  loadExecApprovals,
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
      defaults: { security: "deny" },
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
      defaults: { security: "deny" },
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
      defaults: { security: "deny" },
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
      defaults: { security: "deny" },
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
      defaults: { security: "deny" },
    });
    saveExecApprovals(file);
    await updateExecApprovals({ update: () => file });
    saveExecApprovals(file);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  // openclaw/openclaw#106971 (closed, unmerged) reproduced this as: an
  // in-flight async lock hold makes the sync lock see ownerPid ===
  // process.pid on the still-held sidecar and fail closed immediately
  // instead of retrying, because pid alone can't distinguish "this is my
  // own nested call" from "an unrelated concurrent operation in the same
  // process." Its proposed fix (an unlocked read fallback) was rejected by
  // review for a real authorization-ordering gap: an unrelated read could
  // observe pre-revocation policy while a write was in flight. The shared
  // held-lock map here fixes the same-process case structurally instead:
  // a nested sync call functions as one continuous critical section, so it
  // sees exactly the not-yet-committed (pre-rename) on-disk state, never a
  // stale post-revocation-should-have-applied read.
  it("lets a nested sync read observe consistent pre-commit state instead of failing closed on same-process contention", async () => {
    const { statePath } = setupStateDir();
    const before = normalizeExecApprovals({
      version: 1,
      defaults: { security: "allowlist" },
      agents: { "*": { allowlist: [{ id: "1", pattern: "ls", source: "allow-always" }] } },
    });
    saveExecApprovals(before);

    let nestedRead: ReturnType<typeof normalizeExecApprovals> | undefined;
    let nestedReadThrew: unknown;
    const origWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
        const target = args[0];
        const isContentTempWrite = typeof target === "string" && target.includes(".tmp");
        if (isContentTempWrite && nestedRead === undefined && nestedReadThrew === undefined) {
          // The async writer holds the lock right now (acquired before this
          // temp-file write) and the rename hasn't happened yet, so a
          // same-process nested read here is exactly #106971's scenario.
          try {
            nestedRead = loadExecApprovals();
          } catch (err) {
            nestedReadThrew = err;
          }
        }
        return origWriteFileSync(...args);
      });

    await updateExecApprovals({
      update: (file) => ({
        ...file,
        agents: { ...file.agents, "*": { ...file.agents?.["*"], allowlist: [] } },
      }),
    });
    writeSpy.mockRestore();

    expect(nestedReadThrew).toBeUndefined();
    expect(nestedRead).toBeDefined();
    // Pre-rename: the nested read must see the not-yet-committed state
    // (allowlist still present), not a torn read and not a spurious
    // fail-closed fallback (which would report security !== "allowlist").
    expect(nestedRead?.agents?.["*"]?.allowlist).toHaveLength(1);

    const after = loadExecApprovals();
    expect(after.agents?.["*"]?.allowlist ?? []).toHaveLength(0);
    expect(fs.existsSync(statePath)).toBe(true);
  });
});
