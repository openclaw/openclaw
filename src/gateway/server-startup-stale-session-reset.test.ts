import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldSkipStaleReset,
  resetStaleRunningSessions,
} from "./server-startup-stale-session-reset.js";

describe("shouldSkipStaleReset", () => {
  it("skips subagent sessions (subagentRole set)", () => {
    expect(shouldSkipStaleReset({ subagentRole: "leaf" } as any, "agent:main:main")).toBe(true);
  });

  it("skips subagent sessions (spawnDepth > 0)", () => {
    expect(shouldSkipStaleReset({ spawnDepth: 1 } as any, "agent:main:main")).toBe(true);
  });

  it("skips cron sessions", () => {
    expect(shouldSkipStaleReset({} as any, "agent:main:main:cron:daily")).toBe(true);
  });

  it("skips ACP sessions", () => {
    expect(shouldSkipStaleReset({} as any, "agent:main:main:acp:session1")).toBe(true);
  });

  it("does not skip regular main sessions", () => {
    expect(shouldSkipStaleReset({} as any, "agent:main:main")).toBe(false);
  });

  it("does not skip sessions with spawnDepth 0", () => {
    expect(shouldSkipStaleReset({ spawnDepth: 0 } as any, "agent:main:main")).toBe(false);
  });
});

describe("resetStaleRunningSessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-session-test-"));
  });

  function createStoreFile(agentId: string, sessions: Record<string, any>) {
    const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify(sessions, null, 2));
  }

  it("resets stale running sessions to failed with abortedLastRun", async () => {
    const nowMs = 10000000;
    const oldTime = nowMs - 600000; // 10 min ago — well past 2-min threshold

    createStoreFile("main", {
      "agent:main:main": {
        status: "running",
        updatedAt: oldTime,
        sessionId: "sess-main",
      },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.storesScanned).toBe(1);
    expect(result.runningCount).toBe(1);
    expect(result.resetCount).toBe(1);
    expect(result.skippedCount).toBe(0);

    // Verify the store was updated
    const storeData = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "agents", "main", "sessions", "sessions.json"), "utf-8"),
    );
    const entry = storeData["agent:main:main"];
    expect(entry.status).toBe("failed");
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.endedAt).toBe(nowMs);
    expect(entry.updatedAt).toBe(nowMs);
  });

  it("skips running sessions that are too recent", async () => {
    const nowMs = 10000000;
    const recentTime = nowMs - 30000; // 30s ago — within 2-min threshold

    createStoreFile("main", {
      "agent:main:main": {
        status: "running",
        updatedAt: recentTime,
        sessionId: "sess-main",
      },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.runningCount).toBe(1);
    expect(result.resetCount).toBe(0);
    expect(result.skippedCount).toBe(1);
  });

  it("skips subagent, cron, and ACP sessions even if stale", async () => {
    const nowMs = 10000000;
    const oldTime = nowMs - 600000;

    createStoreFile("main", {
      "agent:main:main:cron:daily": {
        status: "running",
        updatedAt: oldTime,
        sessionId: "sess-cron",
      },
      "agent:main:main:acp:task": {
        status: "running",
        updatedAt: oldTime,
        sessionId: "sess-acp",
      },
      "agent:main:main:sub": {
        status: "running",
        updatedAt: oldTime,
        subagentRole: "leaf",
        sessionId: "sess-sub",
      },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.runningCount).toBe(3);
    expect(result.resetCount).toBe(0);
    expect(result.skippedCount).toBe(3);
  });

  it("handles missing updatedAt by resetting the session (treats as old)", async () => {
    const nowMs = 10000000;

    createStoreFile("main", {
      "agent:main:main": {
        status: "running",
        // No updatedAt — treated as stale
        sessionId: "sess-no-ts",
      },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.resetCount).toBe(1);
  });

  it("processes multiple agent stores", async () => {
    const nowMs = 10000000;
    const oldTime = nowMs - 600000;

    createStoreFile("main", {
      "agent:main:main": { status: "running", updatedAt: oldTime, sessionId: "s1" },
    });
    createStoreFile("junie", {
      "agent:junie:main": { status: "running", updatedAt: oldTime, sessionId: "s2" },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.storesScanned).toBe(2);
    expect(result.runningCount).toBe(2);
    expect(result.resetCount).toBe(2);
  });

  it("returns zeroed result when session dirs cannot be resolved", async () => {
    const result = await resetStaleRunningSessions({
      stateDir: "/nonexistent/path/that/does/not/exist",
      nowMs: Date.now(),
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.storesScanned).toBe(0);
    expect(result.resetCount).toBe(0);
  });

  it("resetAllRunning=true resets recently-updated sessions (startup mode)", async () => {
    // After a gateway restart, no process is alive, so even sessions updated
    // 30 seconds ago are stale — the threshold check should be bypassed.
    const nowMs = 10000000;
    const recentTime = nowMs - 30000; // 30s ago — within 2-min threshold

    createStoreFile("main", {
      "agent:main:main": {
        status: "running",
        updatedAt: recentTime,
        sessionId: "sess-main",
      },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      resetAllRunning: true,
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.storesScanned).toBe(1);
    expect(result.runningCount).toBe(1);
    expect(result.resetCount).toBe(1);
    expect(result.skippedCount).toBe(0);

    // Verify the store was updated
    const storeData = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "agents", "main", "sessions", "sessions.json"), "utf-8"),
    );
    const entry = storeData["agent:main:main"];
    expect(entry.status).toBe("failed");
    expect(entry.abortedLastRun).toBe(true);
  });

  it("resetAllRunning=true still skips subagent, cron, and ACP sessions", async () => {
    const nowMs = 10000000;
    const recentTime = nowMs - 30000;

    createStoreFile("main", {
      "agent:main:main:cron:daily": {
        status: "running",
        updatedAt: recentTime,
        sessionId: "sess-cron",
      },
      "agent:main:main:acp:task": {
        status: "running",
        updatedAt: recentTime,
        sessionId: "sess-acp",
      },
      "agent:main:main:sub": {
        status: "running",
        updatedAt: recentTime,
        subagentRole: "leaf",
        sessionId: "sess-sub",
      },
      "agent:main:main": {
        status: "running",
        updatedAt: recentTime,
        sessionId: "sess-main",
      },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      resetAllRunning: true,
      log: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result.runningCount).toBe(4);
    expect(result.resetCount).toBe(1); // Only the main session (others skipped)
    expect(result.skippedCount).toBe(3);
  });

  it("resetAllRunning=false (default) still skips recently-updated sessions", async () => {
    const nowMs = 10000000;
    const recentTime = nowMs - 30000; // 30s ago

    createStoreFile("main", {
      "agent:main:main": {
        status: "running",
        updatedAt: recentTime,
        sessionId: "sess-main",
      },
    });

    const result = await resetStaleRunningSessions({
      stateDir: tmpDir,
      nowMs,
      staleThresholdMs: 2 * 60 * 1000,
      // resetAllRunning defaults to false
      log: { warn: vi.fn(), info: vi.fn() },
    });

    // Without resetAllRunning, recent sessions are skipped
    expect(result.runningCount).toBe(1);
    expect(result.resetCount).toBe(0);
    expect(result.skippedCount).toBe(1);
  });
});
