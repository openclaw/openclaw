// Doctor session lock tests cover stale lock detection, repair, and session-store lock diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

import {
  detectStaleSessionLocks,
  noteSessionLockHealth,
  sessionLockToHealthFinding,
  sessionLockToRepairEffect,
} from "./doctor-session-locks.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected missing path: ${targetPath}`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
}

function firstNoteCall(): [string, string] {
  const call = note.mock.calls[0];
  if (!call) {
    throw new Error("expected note call");
  }
  return call as [string, string];
}

describe("noteSessionLockHealth", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    note.mockClear();
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-doctor-locks-",
    });
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it("reports existing lock files with pid status and age", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    const lockPath = path.join(sessionsDir, "active.jsonl.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 1500).toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({
      shouldRepair: false,
      staleMs: 60_000,
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = firstNoteCall();
    expect(title).toBe("Session locks");
    expect(message).toContain("Found 1 session lock file");
    expect(message).toContain(`pid=${process.pid} (alive)`);
    expect(message).toContain("stale=no");
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("removes stale locks in repair mode", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const staleLock = path.join(sessionsDir, "stale.jsonl.lock");
    const freshLock = path.join(sessionsDir, "fresh.jsonl.lock");

    await fs.writeFile(
      staleLock,
      JSON.stringify({ pid: -1, createdAt: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );
    await fs.writeFile(
      freshLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({
      shouldRepair: true,
      staleMs: 30_000,
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = firstNoteCall();
    expect(message).toContain("[removed]");
    expect(message).toContain("Removed 1 stale session lock file");

    await expectPathMissing(staleLock);
    await expect(fs.access(freshLock)).resolves.toBeUndefined();
  });

  it("reports a preserved unreadable lock in repair mode instead of hiding it", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    const lockPath = path.join(sessionsDir, "unreadable.jsonl.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );
    const staleDate = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, staleDate, staleDate);

    const realReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementation(((
      target: Parameters<typeof fs.readFile>[0],
      ...rest: unknown[]
    ) => {
      if (String(target) === lockPath) {
        return Promise.reject(Object.assign(new Error("EAGAIN"), { code: "EAGAIN", errno: -11 }));
      }
      return (realReadFile as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.readFile);

    try {
      await noteSessionLockHealth({
        shouldRepair: true,
        staleMs: 30_000,
        readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
      });

      const [message] = firstNoteCall();
      // Sustained EAGAIN means cleanup never inspected the lock: it must be kept AND
      // surfaced, and must not claim pid/age/stale facts it never read.
      expect(message).toContain("unreadable (transient read errors persisted) [preserved]");
      expect(message).toContain("1 lock file was unreadable and left in place");
      expect(message).not.toContain("[removed]");
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces an unreadable lock as a health finding and a preserve effect", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    const lockPath = path.join(sessionsDir, "unreadable.jsonl.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid }), "utf8");
    const staleDate = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, staleDate, staleDate);

    const realReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementation(((
      target: Parameters<typeof fs.readFile>[0],
      ...rest: unknown[]
    ) => {
      if (String(target) === lockPath) {
        return Promise.reject(Object.assign(new Error("EAGAIN"), { code: "EAGAIN", errno: -11 }));
      }
      return (realReadFile as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.readFile);

    try {
      const detected = await detectStaleSessionLocks({ staleMs: 30_000 });
      expect(detected).toHaveLength(1);
      expect(detected[0]?.unreadable).toBe(true);

      const finding = sessionLockToHealthFinding(detected[0]!);
      expect(finding.message).toContain("Unreadable session lock file");
      expect(finding.fixHint).toContain("could not be read");

      expect(sessionLockToRepairEffect(detected[0]!).action).toBe(
        "would-preserve-unreadable-session-lock",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("detects stale locks without removing them for structured lint", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const staleLock = path.join(sessionsDir, "stale.jsonl.lock");
    const freshLock = path.join(sessionsDir, "fresh.jsonl.lock");

    await fs.writeFile(
      staleLock,
      JSON.stringify({ pid: -1, createdAt: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );
    await fs.writeFile(
      freshLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    const locks = await detectStaleSessionLocks({
      staleMs: 30_000,
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
    });

    expect(locks).toHaveLength(1);
    expect(locks[0]?.lockPath).toBe(staleLock);
    await expect(fs.access(staleLock)).resolves.toBeUndefined();
    await expect(fs.access(freshLock)).resolves.toBeUndefined();
  });

  it("maps stale locks to structured findings and dry-run effects", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    const lockPath = path.join(sessionsDir, "stale.jsonl.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: -1, createdAt: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );

    const [lock] = await detectStaleSessionLocks({
      staleMs: 30_000,
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
    });
    if (!lock) {
      throw new Error("expected stale session lock");
    }

    expect(sessionLockToHealthFinding(lock)).toEqual(
      expect.objectContaining({
        checkId: "core/doctor/session-locks",
        severity: "warning",
        path: lockPath,
      }),
    );
    expect(sessionLockToRepairEffect(lock)).toEqual({
      kind: "state",
      action: "would-remove-stale-session-lock",
      target: lockPath,
      dryRunSafe: false,
    });
  });

  it("preserves fresh malformed stale locks in dry-run repair effects", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const malformedLock = path.join(sessionsDir, "malformed.jsonl.lock");
    await fs.writeFile(malformedLock, "{}", "utf8");

    const [lock] = await detectStaleSessionLocks({
      staleMs: 30_000,
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
    });
    if (!lock) {
      throw new Error("expected stale session lock");
    }

    expect(lock.staleReasons).toEqual(["missing-pid", "invalid-createdAt"]);
    expect(lock.removable).toBe(false);
    expect(sessionLockToHealthFinding(lock).fixHint).toContain("after the cleanup grace period");
    expect(sessionLockToRepairEffect(lock)).toEqual({
      kind: "state",
      action: "would-preserve-mtime-gated-stale-session-lock",
      target: malformedLock,
      dryRunSafe: false,
    });
    await expect(fs.access(malformedLock)).resolves.toBeUndefined();
  });

  it("uses the supplied env to choose the structured lint state dir", async () => {
    const other = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-doctor-locks-other-",
      applyEnv: false,
    });
    try {
      await fs.mkdir(other.sessionsDir(), { recursive: true });
      const lockPath = path.join(other.sessionsDir(), "other-stale.jsonl.lock");
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: -1, createdAt: new Date(Date.now() - 120_000).toISOString() }),
        "utf8",
      );

      const locks = await detectStaleSessionLocks({
        env: other.env,
        staleMs: 30_000,
        readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
      });

      expect(locks.map((lock) => lock.lockPath)).toEqual([lockPath]);
    } finally {
      await other.cleanup();
    }
  });

  it("preserves report-only live OpenClaw locks in dry-run repair effects", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const reportOnlyLock = path.join(sessionsDir, "report-only.jsonl.lock");
    await fs.writeFile(
      reportOnlyLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 45_000).toISOString() }),
      "utf8",
    );

    const [lock] = await detectStaleSessionLocks({
      staleMs: 30_000,
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
    });
    if (!lock) {
      throw new Error("expected stale session lock");
    }

    expect(lock.staleReasons).toEqual(["too-old"]);
    expect(sessionLockToHealthFinding(lock).fixHint).toBe(
      "OpenClaw is preserving this live owned lock; inspect the owning process if it appears stuck.",
    );
    expect(sessionLockToRepairEffect(lock)).toEqual({
      kind: "state",
      action: "would-preserve-report-only-stale-session-lock",
      target: reportOnlyLock,
      dryRunSafe: false,
    });
    await expect(fs.access(reportOnlyLock)).resolves.toBeUndefined();
  });

  it("uses the emergency stale-threshold environment override without removing live OpenClaw lock files", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const configuredStaleLock = path.join(sessionsDir, "configured-stale.jsonl.lock");
    await fs.writeFile(
      configuredStaleLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 45_000).toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({
      shouldRepair: true,
      env: { OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "30000" },
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = firstNoteCall();
    expect(message).toContain("stale=yes (too-old)");
    expect(message).not.toContain("[removed]");
    await expect(fs.access(configuredStaleLock)).resolves.toBeUndefined();
  });

  it("removes fresh live locks when the owner is not an OpenClaw process", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const falseLiveLock = path.join(sessionsDir, "false-live.jsonl.lock");
    await fs.writeFile(
      falseLiveLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({
      shouldRepair: true,
      staleMs: 60_000,
      readOwnerProcessArgs: () => ["python", "worker.py"],
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = firstNoteCall();
    expect(message).toContain("stale=yes (non-openclaw-owner)");
    expect(message).toContain("[removed]");
    expect(message).toContain("Removed 1 stale session lock file");
    await expect(fs.access(falseLiveLock)).rejects.toThrow();
  });
});
