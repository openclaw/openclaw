import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendMemoryHostEvent,
  buildMemoryCuratorAuditReport,
  buildMemoryCuratorApprovalRequest,
  loadMemoryCuratorAuditReport,
  loadMemoryCuratorGuardSummary,
  readMemoryHostEvents,
  resolveMemoryHostEventLogPath,
  summarizeMemoryCuratorGuardEvents,
} from "./memory-host-events.js";
import type { MemoryHostEvent } from "./memory-host-events.js";
import { createClaimableDedupe, createPersistentDedupe } from "./persistent-dedupe.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDir } = createPluginSdkTestHarness();

function createDedupe(root: string, overrides?: { ttlMs?: number }) {
  return createPersistentDedupe({
    ttlMs: overrides?.ttlMs ?? 24 * 60 * 60 * 1000,
    memoryMaxSize: 100,
    fileMaxEntries: 1000,
    resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
  });
}

describe("memory host event journal helpers", () => {
  it("appends and reads typed workspace events", async () => {
    const workspaceDir = await createTempDir("memory-host-events-");

    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: "2026-04-05T12:00:00.000Z",
      query: "glacier backup",
      resultCount: 1,
      results: [
        {
          path: "memory/2026-04-05.md",
          startLine: 1,
          endLine: 3,
          score: 0.9,
        },
      ],
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.dream.completed",
      timestamp: "2026-04-05T13:00:00.000Z",
      phase: "light",
      lineCount: 4,
      storageMode: "both",
      inlinePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
      reportPath: path.join(workspaceDir, "memory", "dreaming", "light", "2026-04-05.md"),
    });

    const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir);
    await expect(fs.readFile(eventLogPath, "utf8")).resolves.toContain(
      '"type":"memory.recall.recorded"',
    );

    const events = await readMemoryHostEvents({ workspaceDir });
    const tail = await readMemoryHostEvents({ workspaceDir, limit: 1 });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("memory.recall.recorded");
    expect(events[1]?.type).toBe("memory.dream.completed");
    expect(tail).toHaveLength(1);
    expect(tail[0]?.type).toBe("memory.dream.completed");
  });

  it("appends redacted memory curator decision events", async () => {
    const workspaceDir = await createTempDir("memory-host-curator-events-");

    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.decision.deny",
      timestamp: "2026-04-05T14:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      decision: "deny",
      targetRelativePath: "MEMORY.md",
      sourcePath: "memory/2026-04-05.md",
      sourceStartLine: 1,
      sourceEndLine: 1,
      evidenceStatus: "Confirmed",
      confidence: "high",
      freshness: "current",
      sensitivityClass: "secret",
      privateOrSharedScope: "private",
      reasons: ["apiKey-like field detected"],
      redactedPreview: "apiKey=[REDACTED]",
      score: 0.91,
      recallCount: 3,
      uniqueQueries: 2,
    });

    const raw = await fs.readFile(resolveMemoryHostEventLogPath(workspaceDir), "utf8");
    expect(raw).toContain('"type":"memory.curator.decision.deny"');
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("sk-test-secret");

    const events = await readMemoryHostEvents({ workspaceDir });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "memory.curator.decision.deny",
      decision: "deny",
      targetRelativePath: "MEMORY.md",
      redactedPreview: "apiKey=[REDACTED]",
    });
  });

  it("summarizes curator guard events without exposing raw previews", async () => {
    const workspaceDir = await createTempDir("memory-host-curator-summary-");

    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.decision.allow",
      timestamp: "2026-04-05T14:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "daily_flush",
      decision: "allow",
      targetRelativePath: "memory/2026-04-05.md",
      evidenceStatus: "Inferred",
      confidence: "Unknown",
      freshness: "current",
      sensitivityClass: "internal",
      privateOrSharedScope: "private",
      reasons: [],
      redactedPreview: "safe note",
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.decision.deny",
      timestamp: "2026-04-05T15:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      decision: "deny",
      targetRelativePath: "MEMORY.md",
      sourcePath: "memory/2026-04-05.md",
      sourceStartLine: 1,
      sourceEndLine: 1,
      evidenceStatus: "Confirmed",
      confidence: "high",
      freshness: "current",
      sensitivityClass: "secret",
      privateOrSharedScope: "private",
      reasons: ["token-like field detected"],
      redactedPreview: "token=[REDACTED]",
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.decision.approval_required",
      timestamp: "2026-04-05T16:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "dreaming_deep",
      decision: "approval_required",
      targetRelativePath: "MEMORY.md",
      sourcePath: "memory/2025-01-01.md",
      sourceStartLine: 4,
      sourceEndLine: 5,
      evidenceStatus: "Confirmed",
      confidence: "medium",
      freshness: "stale",
      sensitivityClass: "private",
      privateOrSharedScope: "shared",
      reasons: ["private memory requires approval before shared/global promotion"],
      redactedPreview: "private preference",
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.private_memory_blocked",
      timestamp: "2026-04-05T17:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "dreaming_deep",
      targetRelativePath: "MEMORY.md",
      reasons: ["private memory blocked"],
      redactedPreview: "withheld",
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.stale_recall",
      timestamp: "2026-04-05T18:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "dreaming_deep",
      targetRelativePath: "MEMORY.md",
      reasons: ["stale recall"],
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.contradiction_detected",
      timestamp: "2026-04-05T19:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "durable_promotion",
      targetRelativePath: "MEMORY.md",
      reasons: ["contradiction"],
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.approval.requested",
      timestamp: "2026-04-05T20:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      approvalId: "plugin:approval-1",
      approvalToolCallId: "memory-curator:abc",
      candidateCount: 1,
      sensitivityClasses: ["private"],
      reasons: ["private memory requires approval"],
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.approval.allowed_once",
      timestamp: "2026-04-05T21:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      approvalId: "plugin:approval-1",
      approvalToolCallId: "memory-curator:abc",
      candidateCount: 1,
      sensitivityClasses: ["private"],
      reasons: ["approved"],
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.approval.requested",
      timestamp: "2026-04-05T22:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      approvalId: "plugin:approval-2",
      approvalToolCallId: "memory-curator:def",
      candidateCount: 1,
      sensitivityClasses: ["private"],
      reasons: ["private memory requires approval"],
    });

    const events = await readMemoryHostEvents({ workspaceDir });
    expect(
      summarizeMemoryCuratorGuardEvents(events, { nowIso: "2026-04-06T00:00:00.000Z" }),
    ).toEqual({
      totalDecisions: 3,
      allowed: 1,
      denied: 1,
      approvalRequired: 1,
      redactions: 1,
      privateBlocks: 1,
      staleRecalls: 1,
      contradictions: 1,
      approvalRequests: 2,
      pendingApprovals: 1,
      approvalsAllowedOnce: 1,
      approvalDenials: 0,
      approvalExpirations: 0,
      approvalReplayBlocks: 0,
      lastDecisionAt: "2026-04-05T22:00:00.000Z",
      lastApprovalRequestedAt: "2026-04-05T22:00:00.000Z",
      trendBuckets: [
        {
          bucketStartIso: "2026-04-05T00:00:00.000Z",
          bucketEndIso: "2026-04-06T00:00:00.000Z",
          allowed: 1,
          denied: 1,
          approvalRequired: 1,
          privateBlocks: 1,
          contradictions: 1,
          staleRecalls: 1,
          approvalReplayBlocks: 0,
          approvalExpirations: 0,
        },
      ],
      alerts: [
        {
          id: "memory-curator.private-blocks-threshold",
          severity: "critical",
          metric: "privateBlocks",
          value: 1,
          threshold: 1,
          message: "Private memory blocks reached 1 (threshold 1).",
        },
        {
          id: "memory-curator.contradictions-threshold",
          severity: "critical",
          metric: "contradictions",
          value: 1,
          threshold: 1,
          message: "Contradiction detections reached 1 (threshold 1).",
        },
      ],
    });
    await expect(
      loadMemoryCuratorGuardSummary({
        workspaceDirs: [workspaceDir],
        nowIso: "2026-04-06T00:00:00.000Z",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        totalDecisions: 3,
        denied: 1,
        redactions: 1,
        trendBuckets: [
          expect.objectContaining({
            bucketStartIso: "2026-04-05T00:00:00.000Z",
            denied: 1,
            approvalRequired: 1,
          }),
        ],
        alerts: expect.arrayContaining([
          expect.objectContaining({
            id: "memory-curator.private-blocks-threshold",
            severity: "critical",
          }),
        ]),
      }),
    );
  });

  it("merges count-only curator trend buckets across workspaces", async () => {
    const firstWorkspaceDir = await createTempDir("memory-host-curator-trend-a-");
    const secondWorkspaceDir = await createTempDir("memory-host-curator-trend-b-");

    await appendMemoryHostEvent(firstWorkspaceDir, {
      type: "memory.curator.decision.deny",
      timestamp: "2026-04-05T23:30:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      decision: "deny",
      targetRelativePath: "MEMORY.md",
      sourcePath: "memory/2026-04-05.md",
      evidenceStatus: "Confirmed",
      confidence: "high",
      freshness: "current",
      sensitivityClass: "secret",
      privateOrSharedScope: "private",
      reasons: ["do not leak sk-test-secret from reason"],
      redactedPreview: "apiKey=[REDACTED]",
    });
    await appendMemoryHostEvent(secondWorkspaceDir, {
      type: "memory.curator.private_memory_blocked",
      timestamp: "2026-04-05T01:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "dreaming_deep",
      targetRelativePath: "MEMORY.md",
      sourcePath: "memory/private-note.md",
      reasons: ["private note blocked"],
      redactedPreview: "Private note with token=[REDACTED]",
    });
    await appendMemoryHostEvent(secondWorkspaceDir, {
      type: "memory.curator.approval.expired",
      timestamp: "2026-04-06T01:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      approvalId: "plugin:approval-secret",
      approvalToolCallId: "memory-curator:abc",
      candidateCount: 1,
      sensitivityClasses: ["private"],
      reasons: ["expired approval"],
    });

    const summary = await loadMemoryCuratorGuardSummary({
      workspaceDirs: [firstWorkspaceDir, secondWorkspaceDir],
      nowIso: "2026-04-07T00:00:00.000Z",
    });

    expect(summary.trendBuckets).toEqual([
      {
        bucketStartIso: "2026-04-05T00:00:00.000Z",
        bucketEndIso: "2026-04-06T00:00:00.000Z",
        allowed: 0,
        denied: 1,
        approvalRequired: 0,
        privateBlocks: 1,
        contradictions: 0,
        staleRecalls: 0,
        approvalReplayBlocks: 0,
        approvalExpirations: 0,
      },
      {
        bucketStartIso: "2026-04-06T00:00:00.000Z",
        bucketEndIso: "2026-04-07T00:00:00.000Z",
        allowed: 0,
        denied: 0,
        approvalRequired: 0,
        privateBlocks: 0,
        contradictions: 0,
        staleRecalls: 0,
        approvalReplayBlocks: 0,
        approvalExpirations: 1,
      },
    ]);
    expect(summary.alerts).toEqual([
      {
        id: "memory-curator.private-blocks-threshold",
        severity: "critical",
        metric: "privateBlocks",
        value: 1,
        threshold: 1,
        message: "Private memory blocks reached 1 (threshold 1).",
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain("sk-test-secret");
    expect(JSON.stringify(summary)).not.toContain("private-note");
    expect(JSON.stringify(summary)).not.toContain("plugin:approval-secret");
    expect(JSON.stringify(summary)).not.toContain("token=[REDACTED]");
  });

  it("emits count-only alerts at thresholds and supports custom thresholds", () => {
    const decisionBase = {
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      targetRelativePath: "MEMORY.md",
      evidenceStatus: "Confirmed",
      confidence: "high",
      freshness: "current",
      sensitivityClass: "secret",
      privateOrSharedScope: "private",
      reasons: ["do not leak token-like reason"],
      redactedPreview: "token=[REDACTED]",
    } as const;
    const signalBase = {
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      targetRelativePath: "MEMORY.md",
      reasons: ["do not leak private note"],
      redactedPreview: "private note [REDACTED]",
    } as const;
    const approvalBase = {
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      candidateCount: 1,
      sensitivityClasses: ["private"],
      reasons: ["do not leak approval reason"],
    } as const;
    const events = [
      ...[0, 1, 2].map(
        (index) =>
          ({
            ...decisionBase,
            type: "memory.curator.decision.deny",
            timestamp: `2026-04-05T00:0${index}:00.000Z`,
            decision: "deny",
          }) satisfies MemoryHostEvent,
      ),
      {
        ...signalBase,
        type: "memory.curator.private_memory_blocked",
        timestamp: "2026-04-05T01:00:00.000Z",
      },
      {
        ...signalBase,
        type: "memory.curator.contradiction_detected",
        timestamp: "2026-04-05T02:00:00.000Z",
      },
      ...[0, 1, 2, 3, 4].map(
        (index) =>
          ({
            ...signalBase,
            type: "memory.curator.stale_recall",
            timestamp: `2026-04-05T03:0${index}:00.000Z`,
          }) satisfies MemoryHostEvent,
      ),
      {
        ...approvalBase,
        type: "memory.curator.approval.replay_blocked",
        timestamp: "2026-04-05T04:00:00.000Z",
        approvalId: "plugin:replay-secret",
      },
      ...[0, 1, 2].map(
        (index) =>
          ({
            ...approvalBase,
            type: "memory.curator.approval.expired",
            timestamp: `2026-04-05T05:0${index}:00.000Z`,
            approvalId: `plugin:expired-${index}`,
          }) satisfies MemoryHostEvent,
      ),
      ...[0, 1, 2].map(
        (index) =>
          ({
            ...approvalBase,
            type: "memory.curator.approval.requested",
            timestamp: `2026-04-05T06:0${index}:00.000Z`,
            approvalId: `plugin:pending-${index}`,
          }) satisfies MemoryHostEvent,
      ),
    ] satisfies MemoryHostEvent[];

    const summary = summarizeMemoryCuratorGuardEvents(events, {
      nowIso: "2026-04-06T00:00:00.000Z",
    });

    expect(summary.alerts.map((alert) => alert.metric)).toEqual([
      "denied",
      "privateBlocks",
      "contradictions",
      "approvalReplayBlocks",
      "staleRecalls",
      "approvalExpirations",
      "pendingApprovals",
    ]);
    expect(summary.alerts.filter((alert) => alert.severity === "critical")).toHaveLength(3);
    expect(JSON.stringify(summary.alerts)).not.toContain("token");
    expect(JSON.stringify(summary.alerts)).not.toContain("private note");
    expect(JSON.stringify(summary.alerts)).not.toContain("plugin:");

    const belowThreshold = summarizeMemoryCuratorGuardEvents(events.slice(0, 2), {
      nowIso: "2026-04-06T00:00:00.000Z",
    });
    expect(belowThreshold.alerts).toEqual([]);

    const custom = summarizeMemoryCuratorGuardEvents(events.slice(0, 1), {
      nowIso: "2026-04-06T00:00:00.000Z",
      alertThresholds: { denied: 1 },
    });
    expect(custom.alerts).toEqual([
      {
        id: "memory-curator.denied-threshold",
        severity: "warning",
        metric: "denied",
        value: 1,
        threshold: 1,
        message: "Denied Memory Curator decisions reached 1 (threshold 1).",
      },
    ]);
  });

  it("builds non-secret Memory Curator audit reports with a bounded window", async () => {
    const workspaceDir = await createTempDir("memory-host-curator-audit-");

    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: "2026-04-05T00:00:00.000Z",
      query: "private note should not appear",
      resultCount: 1,
      results: [{ path: "memory/private-note.md", startLine: 1, endLine: 1, score: 0.9 }],
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.decision.deny",
      timestamp: "2026-04-05T01:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "cli_promote_apply",
      decision: "deny",
      targetRelativePath: "MEMORY.md",
      sourcePath: "memory/private-note.md",
      sourceStartLine: 1,
      sourceEndLine: 1,
      evidenceStatus: "Confirmed",
      confidence: "high",
      freshness: "current",
      sensitivityClass: "secret",
      privateOrSharedScope: "private",
      reasons: ["do not expose sk-test-secret"],
      redactedPreview: "token=[REDACTED]",
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.curator.decision.allow",
      timestamp: "2025-12-01T01:00:00.000Z",
      agentId: "memory-knowledge-curator",
      operation: "daily_flush",
      decision: "allow",
      targetRelativePath: "memory/2025-12-01.md",
      evidenceStatus: "Inferred",
      confidence: "Unknown",
      freshness: "stale",
      sensitivityClass: "internal",
      privateOrSharedScope: "private",
      reasons: [],
      redactedPreview: "old note",
    });

    const report = await loadMemoryCuratorAuditReport({
      workspaceDirs: [workspaceDir],
      days: 90,
      nowIso: "2026-04-06T00:00:00.000Z",
    });

    expect(report.windowDays).toBe(90);
    expect(report.sourceEventCount).toBe(3);
    expect(report.curatorEventCount).toBe(1);
    expect(report.decisionEventCounts).toEqual({
      allow: 0,
      deny: 1,
      approvalRequired: 0,
    });
    expect(report.alertCounts.total).toBe(0);
    expect(JSON.stringify(report)).not.toContain("private-note");
    expect(JSON.stringify(report)).not.toContain("sk-test-secret");
    expect(JSON.stringify(report)).not.toContain("token=[REDACTED]");

    const capped = buildMemoryCuratorAuditReport([], {
      days: 999,
      nowIso: "2026-04-06T00:00:00.000Z",
    });
    expect(capped.windowDays).toBe(90);
  });

  it("builds redacted allow-once-only memory curator approval requests", () => {
    const request = buildMemoryCuratorApprovalRequest({
      operation: "cli_promote_apply",
      candidates: [
        {
          key: "memory:memory/2026-04-05.md:1:1",
          sourcePath: "memory/2026-04-05.md",
          sourceStartLine: 1,
          sourceEndLine: 1,
          evidenceStatus: "Confirmed",
          confidence: "medium",
          freshness: "stale",
          sensitivityClass: "private",
          privateOrSharedScope: "shared",
          reasons: ["private memory requires approval before shared/global promotion"],
          redactedPreview: "Private acquisition preference.",
          score: 0.9,
          recallCount: 4,
          uniqueQueries: 2,
        },
      ],
    });

    expect(request.pluginId).toBe("memory-core");
    expect(request.toolName).toBe("memory.promote");
    expect(request.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(request.allowedDecisions).not.toContain("allow-always");
    expect(request.toolCallId).toMatch(/^memory-curator:/);
    expect(JSON.stringify(request)).not.toContain("sk-test-secret");
  });

  it("rejects secret-class memory approval requests", () => {
    expect(() =>
      buildMemoryCuratorApprovalRequest({
        operation: "cli_promote_apply",
        candidates: [
          {
            key: "memory:memory/2026-04-05.md:1:1",
            evidenceStatus: "Confirmed",
            confidence: "high",
            freshness: "current",
            sensitivityClass: "secret",
            privateOrSharedScope: "private",
            reasons: ["secret-like field detected"],
            redactedPreview: "apiKey=[REDACTED]",
          },
        ],
      }),
    ).toThrow(/secret memory content must be denied/);
  });
});

describe("createPersistentDedupe", () => {
  it("deduplicates keys, persists across instances, warms up, and checks recent keys", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const first = createDedupe(root);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(true);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(false);

    const second = createDedupe(root);
    expect(await second.hasRecent("m1", { namespace: "a" })).toBe(true);
    expect(await second.warmup("a")).toBe(1);
    expect(await second.checkAndRecord("m1", { namespace: "a" })).toBe(false);
    expect(await second.checkAndRecord("m2", { namespace: "a" })).toBe(true);

    const raceDedupe = createDedupe(root, { ttlMs: 10_000 });
    const [raceFirst, raceSecond] = await Promise.all([
      raceDedupe.checkAndRecord("race-key", { namespace: "feishu" }),
      raceDedupe.checkAndRecord("race-key", { namespace: "feishu" }),
    ]);
    expect(raceFirst).toBe(true);
    expect(raceSecond).toBe(false);
  });

  it("falls back to memory-only behavior on disk errors", async () => {
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => path.join("/dev/null", "dedupe.json"),
    });

    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(true);
    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(false);
  });

  it("warms empty namespaces and skips expired disk entries", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const emptyReader = createDedupe(root, { ttlMs: 10_000 });
    expect(await emptyReader.warmup("nonexistent")).toBe(0);

    const oldNow = Date.now() - 2000;
    await fs.writeFile(
      path.join(root, "acct.json"),
      JSON.stringify({ "old-msg": oldNow, "new-msg": Date.now() }),
    );

    const reader = createDedupe(root, { ttlMs: 1000 });
    expect(await reader.warmup("acct")).toBe(1);
    expect(await reader.checkAndRecord("old-msg", { namespace: "acct" })).toBe(true);
    expect(await reader.checkAndRecord("new-msg", { namespace: "acct" })).toBe(false);
  });
});

describe("createClaimableDedupe", () => {
  it("mirrors in-flight duplicates, serializes races, and records on commit", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    await expect(dedupe.claim("line:evt-1")).resolves.toEqual({ kind: "claimed" });
    const duplicate = await dedupe.claim("line:evt-1");
    expect(duplicate.kind).toBe("inflight");

    const commit = dedupe.commit("line:evt-1");
    await expect(commit).resolves.toBe(true);
    if (duplicate.kind === "inflight") {
      await expect(duplicate.pending).resolves.toBe(true);
    }
    await expect(dedupe.claim("line:evt-1")).resolves.toEqual({ kind: "duplicate" });

    const claims = await Promise.all([dedupe.claim("line:race-1"), dedupe.claim("line:race-1")]);
    const countClaimKind = (kind: (typeof claims)[number]["kind"]) =>
      claims.reduce((count, claim) => count + (claim.kind === kind ? 1 : 0), 0);
    expect(countClaimKind("claimed")).toBe(1);
    expect(countClaimKind("inflight")).toBe(1);

    const waitingClaim = claims.find((claim) => claim.kind === "inflight");
    await expect(dedupe.commit("line:race-1")).resolves.toBe(true);
    if (waitingClaim?.kind === "inflight") {
      await expect(waitingClaim.pending).resolves.toBe(true);
    }
    await expect(dedupe.claim("line:race-1")).resolves.toEqual({ kind: "duplicate" });
  });

  it("rejects waiting duplicates when the active claim releases with an error", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    await expect(dedupe.claim("line:evt-2")).resolves.toEqual({ kind: "claimed" });
    const duplicate = await dedupe.claim("line:evt-2");
    expect(duplicate.kind).toBe("inflight");

    const failure = new Error("transient failure");
    dedupe.release("line:evt-2", { error: failure });
    if (duplicate.kind === "inflight") {
      await expect(duplicate.pending).rejects.toThrow("transient failure");
    }
    await expect(dedupe.claim("line:evt-2")).resolves.toEqual({ kind: "claimed" });
  });

  it("supports persistent-backed recent checks and warmup", async () => {
    const root = await createTempDir("openclaw-claimable-dedupe-");
    const writer = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
    });

    await expect(writer.claim("m1", { namespace: "acct" })).resolves.toEqual({ kind: "claimed" });
    await expect(writer.commit("m1", { namespace: "acct" })).resolves.toBe(true);

    const reader = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
    });

    expect(await reader.hasRecent("m1", { namespace: "acct" })).toBe(true);
    expect(await reader.warmup("acct")).toBe(1);
    await expect(reader.claim("m1", { namespace: "acct" })).resolves.toEqual({
      kind: "duplicate",
    });
  });
});
