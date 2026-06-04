// Cron session reaper tests cover cleanup of sessions created by scheduled runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import type { Logger } from "./service/state.js";
import {
  buildCronSweepStorePaths,
  buildKnownCronJobSessionKeys,
  resolveCronJobAgentId,
  sweepCronRunSessions,
  resolveRetentionMs,
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

describe("resolveCronJobAgentId", () => {
  // Mirrors resolveCronAgent: only a configured id wins; anything else → default.
  const resolveCronAgentId = (requested?: string | null) =>
    requested === "configured" ? "configured" : "main";

  it("uses the runtime resolver result when present", () => {
    expect(
      resolveCronJobAgentId(
        { agentId: "configured" },
        { defaultAgentId: "main", resolveCronAgentId },
      ),
    ).toBe("configured");
  });

  it("falls back to the default for a dangling/non-configured agent id", () => {
    expect(
      resolveCronJobAgentId({ agentId: "ghost" }, { defaultAgentId: "main", resolveCronAgentId }),
    ).toBe("main");
  });

  it("uses the raw agent id when no resolver is provided", () => {
    expect(resolveCronJobAgentId({ agentId: "custom" }, { defaultAgentId: "main" })).toBe("custom");
  });

  it("falls back to the default when the job has no agent id", () => {
    expect(resolveCronJobAgentId({ agentId: undefined }, { defaultAgentId: "main" })).toBe("main");
  });
});

describe("buildKnownCronJobSessionKeys", () => {
  it("reconstructs each live job's base key under its runtime-resolved agent", () => {
    // A dangling agent id must resolve to the default — matching where the runtime
    // stored the row — so the live job is protected, not misread as an orphan.
    const resolveCronAgentId = (requested?: string | null) =>
      requested === "real" ? "real" : "main";
    const keys = buildKnownCronJobSessionKeys(
      [
        { id: "iso", sessionTarget: "isolated" },
        { id: "ghosted", sessionTarget: "isolated", agentId: "ghost" },
        { id: "scoped", sessionTarget: "isolated", agentId: "real" },
        { id: "named", sessionTarget: "session:cron:weekly" },
      ],
      { defaultAgentId: "main", resolveCronAgentId },
    );
    expect(keys).toEqual(
      new Set([
        "agent:main:cron:iso",
        "agent:main:cron:ghosted",
        "agent:real:cron:scoped",
        "agent:main:cron:weekly",
      ]),
    );
    // The dangling job resolves under the default agent, never agent:ghost:*.
    expect(keys.has("agent:ghost:cron:ghosted")).toBe(false);
  });

  it("skips jobs whose sessionTarget cannot resolve to a key", () => {
    const keys = buildKnownCronJobSessionKeys([{ id: "bad", sessionTarget: "session:" }], {
      defaultAgentId: "main",
    });
    expect(keys.size).toBe(0);
  });
});

describe("buildCronSweepStorePaths", () => {
  it("sweeps live-job agents, configured agents, and the default store", () => {
    // "beta" is configured but has no live cron job — its store must still be
    // swept so a deleted job's orphan there is reaped (the P2 coverage gap).
    const paths = buildCronSweepStorePaths({
      jobs: [{ id: "j1", sessionTarget: "isolated", agentId: "alpha" }],
      configuredAgentIds: ["alpha", "beta"],
      agentResolution: { defaultAgentId: "main" },
      resolveSessionStorePath: (agentId) => `/store/${agentId}.json`,
    });
    expect(paths).toEqual(new Set(["/store/alpha.json", "/store/beta.json", "/store/main.json"]));
  });

  it("falls back to the single sessionStorePath when no per-agent resolver", () => {
    const paths = buildCronSweepStorePaths({
      jobs: [],
      configuredAgentIds: [],
      agentResolution: { defaultAgentId: "main" },
      sessionStorePath: "/shared/sessions.json",
    });
    expect(paths).toEqual(new Set(["/shared/sessions.json"]));
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

  it("prunes stale base sessions orphaned by deleted jobs", async () => {
    // Base keys absent from the live-job ownership set are orphans left by
    // deleted jobs; prune them when stale, keep fresh ones until they age out.
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
      knownCronJobSessionKeys: new Set(),
    });

    expect(result.pruned).toBe(1);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:orphan-fresh": { sessionId: "fresh-base", updatedAt: now - 1 * 3_600_000 },
    });
  });

  it("preserves a live isolated job's stale base session, keeping carried model/auth/label (#89666)", async () => {
    // Regression guard for the ClawSweeper P1: an isolated job that runs less
    // often than the retention window goes stale between runs, but its base row
    // carries the user's model/auth/label overrides into the next run (see
    // resolveCronSession). A live job's row must survive; only the deleted job's
    // orphan is pruned.
    const now = Date.now();
    const liveKey = "agent:main:cron:weekly-isolated";
    const store: Record<string, { sessionId: string; modelOverride?: string; updatedAt: number }> =
      {
        [liveKey]: {
          sessionId: "iso-live",
          modelOverride: "gpt-5.5",
          updatedAt: now - 25 * 3_600_000,
        },
        "agent:main:cron:deleted-isolated": {
          sessionId: "iso-orphan",
          updatedAt: now - 25 * 3_600_000,
        },
      };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
      knownCronJobSessionKeys: new Set([liveKey]),
    });

    expect(result.pruned).toBe(1); // only the deleted job's orphan is pruned
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      [liveKey]: {
        sessionId: "iso-live",
        modelOverride: "gpt-5.5",
        updatedAt: now - 25 * 3_600_000,
      },
    });
  });

  it("preserves a live job's stale base session while pruning its expired :run: rows", async () => {
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
      knownCronJobSessionKeys: new Set(["agent:main:cron:main-job"]),
    });

    expect(result.pruned).toBe(1); // expired :run: pruned, owned base preserved
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:main-job": { sessionId: "main-base", updatedAt: now - 25 * 3_600_000 },
    });
  });

  it("preserves a persistent named cron session via knownCronJobSessionKeys", async () => {
    // A job with sessionTarget="session:cron:weekly" produces base key
    // agent:main:cron:weekly. A live job owns it, so it is never pruned even
    // when stale; the orphan from a deleted job is.
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
      knownCronJobSessionKeys: new Set(["agent:main:cron:weekly"]),
    });

    expect(result.pruned).toBe(1); // orphaned pruned; weekly preserved
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:weekly": { sessionId: "weekly-base", updatedAt: now - 25 * 3_600_000 },
    });
  });

  it("preserves base cron keys when no ownership set is provided", async () => {
    // Without the live-job set, orphans cannot be told from live jobs, so base
    // keys are never pruned — only :run: rows are. This is the fail-safe default.
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:isolated-stale": { sessionId: "iso-stale", updatedAt: now - 25 * 3_600_000 },
      "agent:main:cron:isolated-stale:run:r1": {
        sessionId: "run1",
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

    expect(result.pruned).toBe(1); // :run: pruned, base preserved (no ownership set)
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:isolated-stale": { sessionId: "iso-stale", updatedAt: now - 25 * 3_600_000 },
    });
  });

  it("archives transcript for a pruned orphaned isolated cron base session", async () => {
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
      knownCronJobSessionKeys: new Set(),
    });

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(isoTranscript)).toBe(false);
    const files = fs.readdirSync(tmpDir);
    const archived = files.filter((name) => name.startsWith(`${isoSessionId}.jsonl.deleted.`));
    expect(archived.length).toBeGreaterThan(0);
  });
});
