import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { addSession, resetProcessRegistryForTests } from "../agents/bash-process-registry.js";
import {
  __testing as embeddedRunTesting,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/pi-embedded-runner/runs.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import type { Logger } from "./service/state.js";
import {
  resolveRetentionMs,
  resetReaperThrottle,
  scanCronRunSessionCandidates,
  sweepCronRunSessions,
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

describe("sweepCronRunSessions", () => {
  let tmpDir: string;
  let storePath: string;
  let cronStorePath: string;
  const log = createTestLogger();

  function writeRunLog(
    jobId: string,
    entries: Array<{
      ts: number;
      sessionKey: string;
      sessionId?: string;
      status?: "ok" | "error" | "skipped";
      summary?: string;
      runAtMs?: number;
    }>,
  ) {
    const runsDir = path.join(path.dirname(cronStorePath), "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const runLogPath = path.join(runsDir, `${jobId}.jsonl`);
    const lines = entries.map((entry) =>
      JSON.stringify({
        action: "finished",
        jobId,
        ...entry,
      }),
    );
    fs.writeFileSync(runLogPath, `${lines.join("\n")}\n`);
  }

  beforeEach(async () => {
    resetReaperThrottle();
    resetProcessRegistryForTests();
    resetTaskRegistryForTests({ persist: false });
    embeddedRunTesting.resetActiveEmbeddedRuns();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-"));
    storePath = path.join(tmpDir, "sessions.json");
    cronStorePath = path.join(tmpDir, "cron", "jobs.json");
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
    writeRunLog("job1", [
      {
        ts: now - 25 * 3_600_000,
        runAtMs: now - 25 * 3_600_000 - 5_000,
        sessionKey: "agent:main:cron:job1:run:old-run",
        sessionId: "old-run",
        status: "ok",
        summary: "HEARTBEAT_OK",
      },
      {
        ts: now - 1 * 3_600_000,
        runAtMs: now - 1 * 3_600_000 - 5_000,
        sessionKey: "agent:main:cron:job1:run:recent-run",
        sessionId: "recent-run",
        status: "ok",
        summary: "done",
      },
    ]);

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      cronStorePath,
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
    writeRunLog("job1", [
      {
        ts: now - 25 * 3_600_000,
        sessionKey: "agent:main:cron:job1:run:old-run",
        sessionId: runSessionId,
        status: "ok",
        summary: "HEARTBEAT_OK",
      },
    ]);

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      cronStorePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(runTranscript)).toBe(false);
    const files = fs.readdirSync(tmpDir);
    expect(files.some((name) => name.startsWith(`${runSessionId}.jsonl.deleted.`))).toBe(true);
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
    writeRunLog("job1", [
      {
        ts: now - 25 * 3_600_000,
        sessionKey: "agent:main:cron:job1:run:old-run",
        sessionId: "old-run",
        status: "ok",
        summary: "HEARTBEAT_OK",
      },
    ]);

    try {
      const result = await sweepCronRunSessions({
        sessionStorePath: storePath,
        cronStorePath,
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
    writeRunLog("job1", [
      {
        ts: now - 2 * 3_600_000,
        sessionKey: "agent:main:cron:job1:run:run1",
        sessionId: "run1",
        status: "ok",
        summary: "done",
      },
    ]);

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: "1h" },
      sessionStorePath: storePath,
      cronStorePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
  });

  it("skips cron run sessions with active related tasks waiting for input", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:wait-task";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "wait-task",
          updatedAt: now - 25 * 3_600_000,
        },
      }),
    );
    writeRunLog("job1", [
      {
        ts: now - 25 * 3_600_000,
        sessionKey,
        sessionId: "wait-task",
        status: "ok",
        summary: "done",
      },
    ]);
    createTaskRecord({
      runtime: "acp",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      task: "ACP background task",
      status: "running",
      progressSummary: "No output for 60s. It may be waiting for input.",
    });

    const scan = await scanCronRunSessionCandidates({
      sessionStorePath: storePath,
      cronStorePath,
      nowMs: now,
      idleThresholdMs: 24 * 3_600_000,
      mode: "standard",
    });

    expect(scan.candidates).toHaveLength(0);
    expect(scan.skipped["active-task"]).toBe(1);
  });

  it("does not prune cron run sessions with active background exec", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:exec-run";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "exec-run",
          updatedAt: now - 25 * 3_600_000,
        },
      }),
    );
    writeRunLog("job1", [
      {
        ts: now - 25 * 3_600_000,
        sessionKey,
        sessionId: "exec-run",
        status: "ok",
        summary: "done",
      },
    ]);
    addSession({
      id: "proc-1",
      command: "sleep 60",
      sessionKey,
      startedAt: now - 5_000,
      maxOutputChars: 4_000,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      pendingStdoutChars: 0,
      pendingStderrChars: 0,
      aggregated: "",
      tail: "",
      exited: false,
      truncated: false,
      backgrounded: true,
      cursorKeyMode: "unknown",
    });

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      cronStorePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(0);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated[sessionKey]).toBeDefined();
  });

  it("skips cron run sessions that still have an active embedded run", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:active-run";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "active-run",
          updatedAt: now - 25 * 3_600_000,
        },
      }),
    );
    writeRunLog("job1", [
      {
        ts: now - 25 * 3_600_000,
        sessionKey,
        sessionId: "active-run",
        status: "ok",
        summary: "done",
      },
    ]);
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    setActiveEmbeddedRun("active-run", handle, sessionKey);

    try {
      const scan = await scanCronRunSessionCandidates({
        sessionStorePath: storePath,
        cronStorePath,
        nowMs: now,
        idleThresholdMs: 24 * 3_600_000,
        mode: "standard",
      });

      expect(scan.candidates).toHaveLength(0);
      expect(scan.skipped["active-session-run"]).toBe(1);
    } finally {
      clearActiveEmbeddedRun("active-run", handle, sessionKey);
    }
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
});
