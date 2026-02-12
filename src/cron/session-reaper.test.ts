import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import type { Logger } from "./service/state.js";
import { isCronRunSessionKey, parseCronRunJobId } from "../sessions/session-key-utils.js";
import {
  sweepCronRunSessions,
  resolveRetentionMs,
  resolveMaxRunsPerJob,
  resetReaperThrottle,
} from "./session-reaper.js";

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("resolveRetentionMs", () => {
  it("returns 24h default when no config", () => {
    expect(resolveRetentionMs()).toBe(24 * 3_600_000);
  });

  it("returns 24h default when config is empty", () => {
    expect(resolveRetentionMs({})).toBe(24 * 3_600_000);
  });

  it("parses duration string", () => {
    expect(resolveRetentionMs({ sessionRetention: "1h" })).toBe(3_600_000);
    expect(resolveRetentionMs({ sessionRetention: "7d" })).toBe(7 * 86_400_000);
    expect(resolveRetentionMs({ sessionRetention: "30m" })).toBe(30 * 60_000);
  });

  it("returns null when disabled", () => {
    expect(resolveRetentionMs({ sessionRetention: false })).toBeNull();
  });

  it("falls back to default on invalid string", () => {
    expect(resolveRetentionMs({ sessionRetention: "abc" })).toBe(24 * 3_600_000);
  });
});

describe("resolveMaxRunsPerJob", () => {
  it("returns 50 default when no config", () => {
    expect(resolveMaxRunsPerJob()).toBe(50);
  });

  it("returns 50 default when config is empty", () => {
    expect(resolveMaxRunsPerJob({})).toBe(50);
  });

  it("accepts a positive integer", () => {
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: 10 })).toBe(10);
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: 1 })).toBe(1);
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: 100 })).toBe(100);
  });

  it("floors fractional values", () => {
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: 5.9 })).toBe(5);
  });

  it("falls back to default for zero or negative", () => {
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: 0 })).toBe(50);
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: -1 })).toBe(50);
  });

  it("falls back to default for non-finite values", () => {
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: Infinity })).toBe(50);
    expect(resolveMaxRunsPerJob({ maxRunsPerJob: NaN })).toBe(50);
  });
});

describe("isCronRunSessionKey", () => {
  it("matches cron run session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456")).toBe(true);
    expect(isCronRunSessionKey("agent:debugger:cron:249ecf82:run:1102aabb")).toBe(true);
  });

  it("does not match base cron session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123")).toBe(false);
  });

  it("does not match regular session keys", () => {
    expect(isCronRunSessionKey("agent:main:telegram:dm:123")).toBe(false);
  });

  it("does not match non-canonical cron-like keys", () => {
    expect(isCronRunSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
    expect(isCronRunSessionKey("cron:job:run:uuid")).toBe(false);
  });
});

describe("parseCronRunJobId", () => {
  it("extracts job ID from valid cron run session key", () => {
    expect(parseCronRunJobId("agent:main:cron:job1:run:abc")).toBe("job1");
    expect(parseCronRunJobId("agent:debugger:cron:249ecf82:run:1102aabb")).toBe("249ecf82");
  });

  it("returns null for base cron session keys", () => {
    expect(parseCronRunJobId("agent:main:cron:job1")).toBeNull();
  });

  it("returns null for regular session keys", () => {
    expect(parseCronRunJobId("agent:main:telegram:dm:123")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseCronRunJobId(null)).toBeNull();
    expect(parseCronRunJobId(undefined)).toBeNull();
  });
});

describe("sweepCronRunSessions", () => {
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetReaperThrottle();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  it("prunes expired cron run sessions", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1": {
        sessionId: "base-session",
        updatedAt: now,
      },
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        updatedAt: now - 25 * 3_600_000, // 25h ago — expired
      },
      "agent:main:cron:job1:run:recent-run": {
        sessionId: "recent-run",
        updatedAt: now - 1 * 3_600_000, // 1h ago — not expired
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000, // old but not a cron run
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:job1"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:old-run"]).toBeUndefined();
    expect(updated["agent:main:cron:job1:run:recent-run"]).toBeDefined();
    expect(updated["agent:main:telegram:dm:123"]).toBeDefined();
  });

  it("respects custom retention", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 2 * 3_600_000, // 2h ago
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: "1h" },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
  });

  it("still runs per-job cap when TTL pruning is disabled", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 100 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    // Sweeps (per-job cap is active) but no entries pruned (only 1 run, under cap)
    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(0);
  });

  it("caps runs per job keeping only the most recent N", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1": {
        sessionId: "base",
        updatedAt: now,
      },
      "agent:main:cron:job1:run:r1": {
        sessionId: "r1",
        updatedAt: now - 1000,
      },
      "agent:main:cron:job1:run:r2": {
        sessionId: "r2",
        updatedAt: now - 2000,
      },
      "agent:main:cron:job1:run:r3": {
        sessionId: "r3",
        updatedAt: now - 3000,
      },
      "agent:main:cron:job1:run:r4": {
        sessionId: "r4",
        updatedAt: now - 4000,
      },
      "agent:main:cron:job1:run:r5": {
        sessionId: "r5",
        updatedAt: now - 5000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false, maxRunsPerJob: 3 },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(2);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    // Base session kept
    expect(updated["agent:main:cron:job1"]).toBeDefined();
    // 3 most recent runs kept
    expect(updated["agent:main:cron:job1:run:r1"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:r2"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:r3"]).toBeDefined();
    // 2 oldest runs removed
    expect(updated["agent:main:cron:job1:run:r4"]).toBeUndefined();
    expect(updated["agent:main:cron:job1:run:r5"]).toBeUndefined();
  });

  it("caps runs independently per job", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:jobA:run:a1": { sessionId: "a1", updatedAt: now - 1000 },
      "agent:main:cron:jobA:run:a2": { sessionId: "a2", updatedAt: now - 2000 },
      "agent:main:cron:jobA:run:a3": { sessionId: "a3", updatedAt: now - 3000 },
      "agent:main:cron:jobB:run:b1": { sessionId: "b1", updatedAt: now - 1000 },
      "agent:main:cron:jobB:run:b2": { sessionId: "b2", updatedAt: now - 2000 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false, maxRunsPerJob: 2 },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1); // only jobA's oldest run removed

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:jobA:run:a1"]).toBeDefined();
    expect(updated["agent:main:cron:jobA:run:a2"]).toBeDefined();
    expect(updated["agent:main:cron:jobA:run:a3"]).toBeUndefined();
    expect(updated["agent:main:cron:jobB:run:b1"]).toBeDefined();
    expect(updated["agent:main:cron:jobB:run:b2"]).toBeDefined();
  });

  it("applies both TTL and per-job cap together", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      // r1 is expired by TTL; r2, r3, r4 are within TTL but r4 exceeds cap of 2
      "agent:main:cron:job1:run:r1": { sessionId: "r1", updatedAt: now - 25 * 3_600_000 },
      "agent:main:cron:job1:run:r2": { sessionId: "r2", updatedAt: now - 1000 },
      "agent:main:cron:job1:run:r3": { sessionId: "r3", updatedAt: now - 2000 },
      "agent:main:cron:job1:run:r4": { sessionId: "r4", updatedAt: now - 3000 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { maxRunsPerJob: 2 },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    // r1 removed by TTL, r4 removed by per-job cap
    expect(result.pruned).toBe(2);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:job1:run:r1"]).toBeUndefined();
    expect(updated["agent:main:cron:job1:run:r2"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:r3"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:r4"]).toBeUndefined();
  });

  it("throttles sweeps without force", async () => {
    const now = Date.now();
    fs.writeFileSync(storePath, JSON.stringify({}));

    // First sweep runs
    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    // Second sweep (1 second later) is throttled
    const r2 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(false);
  });

  it("throttles per store path", async () => {
    const now = Date.now();
    const otherPath = path.join(tmpDir, "sessions-other.json");
    fs.writeFileSync(storePath, JSON.stringify({}));
    fs.writeFileSync(otherPath, JSON.stringify({}));

    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    const r2 = await sweepCronRunSessions({
      sessionStorePath: otherPath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(true);

    const r3 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r3.swept).toBe(false);
  });
});
