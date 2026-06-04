import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import type { Logger } from "./service/state.js";
import { sweepCronRunSessions, resolveRetentionMs, resetReaperThrottle } from "./session-reaper.js";

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

describe("isCronRunSessionKey", () => {
  it("matches cron run session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456")).toBe(true);
    expect(isCronRunSessionKey("agent:debugger:cron:249ecf82:run:1102aabb")).toBe(true);
  });

  it("matches cron run descendant session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456:subagent:worker")).toBe(true);
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456:thread:reply")).toBe(true);
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
      "agent:main:cron:job1:run:old-run:subagent:worker": {
        sessionId: "old-run-child",
        updatedAt: now - 25 * 3_600_000, // expired cron-run descendant
      },
      "agent:main:cron:job1:run:recent-run": {
        sessionId: "recent-run",
        updatedAt: now - 1 * 3_600_000, // 1h ago — not expired
      },
      "agent:main:cron:job1:run:recent-run:thread:reply": {
        sessionId: "recent-run-thread",
        updatedAt: now - 1 * 3_600_000, // active cron-run descendant
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
    expect(result.pruned).toBe(2);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:job1": {
        sessionId: "base-session",
        updatedAt: now,
      },
      "agent:main:cron:job1:run:recent-run": {
        sessionId: "recent-run",
        updatedAt: now - 1 * 3_600_000,
      },
      "agent:main:cron:job1:run:recent-run:thread:reply": {
        sessionId: "recent-run-thread",
        updatedAt: now - 1 * 3_600_000,
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000,
      },
    });
  });

  it("archives transcript files for pruned run sessions that are no longer referenced", async () => {
    const now = Date.now();
    const runSessionId = "old-run";
    const runTranscript = path.join(tmpDir, `${runSessionId}.jsonl`);
    fs.writeFileSync(runTranscript, '{"type":"session"}\n');
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:old-run": {
        sessionId: runSessionId,
        updatedAt: now - 25 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(runTranscript)).toBe(false);
    const files = fs.readdirSync(tmpDir);
    const archivedRunTranscripts = files.filter((name) =>
      name.startsWith(`${runSessionId}.jsonl.deleted.`),
    );
    expect(archivedRunTranscripts.length).toBeGreaterThan(0);
  });

  it("does not archive external transcript paths for pruned runs", async () => {
    const now = Date.now();
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-external-"));
    const externalTranscript = path.join(externalDir, "outside.jsonl");
    fs.writeFileSync(externalTranscript, '{"type":"session"}\n');
    const store: Record<string, { sessionId: string; sessionFile?: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        sessionFile: externalTranscript,
        updatedAt: now - 25 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    try {
      const result = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now,
        log,
        force: true,
      });

      expect(result.pruned).toBe(1);
      expect(fs.existsSync(externalTranscript)).toBe(true);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
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

  it("does nothing when pruning is disabled", async () => {
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

    expect(result.swept).toBe(false);
    expect(result.pruned).toBe(0);
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

  it("prunes orphaned base sessions with no :run: siblings", async () => {
    // Base keys without :run: siblings are isolated-target or deleted-job remnants; prune when stale.
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:orphan-stale": { sessionId: "stale-base", updatedAt: now - 25 * 3_600_000 },
      "agent:main:cron:orphan-fresh": { sessionId: "fresh-base", updatedAt: now - 1 * 3_600_000 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:orphan-fresh": { sessionId: "fresh-base", updatedAt: now - 1 * 3_600_000 },
    });
  });

  it("preserves stale main-target base session when :run: siblings exist", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:main-job": { sessionId: "main-base", updatedAt: now - 25 * 3_600_000 },
      "agent:main:cron:main-job:run:run1": { sessionId: "run1", updatedAt: now - 25 * 3_600_000 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1); // :run: pruned, base preserved
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:main-job": { sessionId: "main-base", updatedAt: now - 25 * 3_600_000 },
    });
  });

  it("preserves persistent named cron session via knownPersistentCronSessionKeys", async () => {
    // A job with sessionTarget="session:cron:weekly" produces base key agent:main:cron:weekly.
    // This must never be pruned even when stale and has no :run: siblings.
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:weekly": { sessionId: "weekly-base", updatedAt: now - 25 * 3_600_000 },
      "agent:main:cron:orphaned": { sessionId: "orphaned-base", updatedAt: now - 25 * 3_600_000 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
      knownPersistentCronSessionKeys: new Set(["agent:main:cron:weekly"]),
    });

    expect(result.pruned).toBe(1); // orphaned pruned; weekly preserved
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:weekly": { sessionId: "weekly-base", updatedAt: now - 25 * 3_600_000 },
    });
  });

  it("prunes expired isolated cron base sessions (no :run: key)", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:isolated-expired": {
        sessionId: "iso-expired",
        updatedAt: now - 25 * 3_600_000,
      },
      "agent:main:cron:isolated-recent": {
        sessionId: "iso-recent",
        updatedAt: now - 1 * 3_600_000,
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000,
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
    expect(updated).toEqual({
      "agent:main:cron:isolated-recent": {
        sessionId: "iso-recent",
        updatedAt: now - 1 * 3_600_000,
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000,
      },
    });
  });

  it("archives transcript for pruned isolated cron base session", async () => {
    const now = Date.now();
    const isoSessionId = "iso-old-session";
    const isoTranscript = path.join(tmpDir, `${isoSessionId}.jsonl`);
    fs.writeFileSync(isoTranscript, '{"type":"session"}\n');
    const store: Record<string, { sessionId: string; sessionFile?: string; updatedAt: number }> = {
      "agent:main:cron:isolated-job": {
        sessionId: isoSessionId,
        sessionFile: isoTranscript,
        updatedAt: now - 25 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(isoTranscript)).toBe(false);
    const files = fs.readdirSync(tmpDir);
    const archived = files.filter((name) => name.startsWith(`${isoSessionId}.jsonl.deleted.`));
    expect(archived.length).toBeGreaterThan(0);
  });
});
