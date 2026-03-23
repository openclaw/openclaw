import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAction,
  appendOutcome,
  pruneOldRecords,
  readActions,
  readAggregates,
  readOutcomes,
  resolveAgentDir,
  resolveStorageDir,
  writeAggregates,
} from "./persistence.js";
import type { ActionRecord, AggregateStats, OutcomeRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeActionRecord(overrides?: Partial<ActionRecord>): ActionRecord {
  return {
    id: "act-001",
    timestamp: "2026-03-22T10:00:00.000Z",
    agentId: "agent-1",
    sessionKey: "session-abc",
    actionType: "agent_reply",
    channelId: "telegram",
    policyMode: "passive",
    ...overrides,
  };
}

function makeOutcomeRecord(overrides?: Partial<OutcomeRecord>): OutcomeRecord {
  return {
    id: "out-001",
    timestamp: "2026-03-22T10:01:00.000Z",
    actionId: "act-001",
    agentId: "agent-1",
    outcomeType: "delivery_success",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-persist-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveStorageDir", () => {
  it("uses the provided home directory", () => {
    const dir = resolveStorageDir("/fake/home");
    expect(dir).toBe("/fake/home/.openclaw/policy-feedback");
  });

  it("defaults to os.homedir()", () => {
    const dir = resolveStorageDir();
    expect(dir).toContain(".openclaw/policy-feedback");
  });
});

describe("resolveAgentDir", () => {
  it("returns a per-agent subdirectory", () => {
    const dir = resolveAgentDir("my-agent", "/fake/home");
    expect(dir).toBe("/fake/home/.openclaw/policy-feedback/agents/my-agent");
  });

  it("rejects agentId with path traversal (..)", () => {
    expect(() => resolveAgentDir("../../etc", "/fake/home")).toThrow(/Invalid agentId/);
  });

  it("rejects agentId with forward slash", () => {
    expect(() => resolveAgentDir("agent/subdir", "/fake/home")).toThrow(/Invalid agentId/);
  });

  it("rejects agentId with backslash", () => {
    expect(() => resolveAgentDir("agent\\subdir", "/fake/home")).toThrow(/Invalid agentId/);
  });

  it("rejects agentId with null byte", () => {
    expect(() => resolveAgentDir("agent\0id", "/fake/home")).toThrow(/Invalid agentId/);
  });

  it("rejects empty agentId", () => {
    expect(() => resolveAgentDir("", "/fake/home")).toThrow(/Invalid agentId/);
  });
});

describe("appendAction / readActions", () => {
  it("creates directory and writes a single action", async () => {
    const record = makeActionRecord();
    await appendAction(record, { home: tmpDir });

    const actions = await readActions({ home: tmpDir });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual(record);
  });

  it("appends multiple actions preserving order", async () => {
    const r1 = makeActionRecord({ id: "act-001" });
    const r2 = makeActionRecord({ id: "act-002", actionType: "tool_call" });
    const r3 = makeActionRecord({ id: "act-003", actionType: "cron_run" });

    await appendAction(r1, { home: tmpDir });
    await appendAction(r2, { home: tmpDir });
    await appendAction(r3, { home: tmpDir });

    const actions = await readActions({ home: tmpDir });
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.id)).toEqual(["act-001", "act-002", "act-003"]);
  });

  it("returns empty array when file does not exist", async () => {
    const actions = await readActions({ home: tmpDir });
    expect(actions).toEqual([]);
  });

  it("skips malformed JSONL lines gracefully", async () => {
    const dir = resolveStorageDir(tmpDir);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "actions.jsonl");
    const validRecord = makeActionRecord();
    const content = JSON.stringify(validRecord) + "\nNOT VALID JSON\n";
    await fs.writeFile(filePath, content, "utf-8");

    const actions = await readActions({ home: tmpDir });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual(validRecord);
  });

  it("supports per-agent scoping", async () => {
    const record = makeActionRecord({ agentId: "scoped-agent" });
    await appendAction(record, { agentId: "scoped-agent", home: tmpDir });

    // Global read should be empty
    const globalActions = await readActions({ home: tmpDir });
    expect(globalActions).toEqual([]);

    // Agent-scoped read should have the record
    const agentActions = await readActions({ agentId: "scoped-agent", home: tmpDir });
    expect(agentActions).toHaveLength(1);
    expect(agentActions[0]).toEqual(record);
  });
});

describe("appendOutcome / readOutcomes", () => {
  it("writes and reads outcome records", async () => {
    const record = makeOutcomeRecord();
    await appendOutcome(record, { home: tmpDir });

    const outcomes = await readOutcomes({ home: tmpDir });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual(record);
  });

  it("appends multiple outcomes", async () => {
    const r1 = makeOutcomeRecord({ id: "out-001" });
    const r2 = makeOutcomeRecord({ id: "out-002", outcomeType: "user_replied" });

    await appendOutcome(r1, { home: tmpDir });
    await appendOutcome(r2, { home: tmpDir });

    const outcomes = await readOutcomes({ home: tmpDir });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.id)).toEqual(["out-001", "out-002"]);
  });

  it("returns empty array when file does not exist", async () => {
    const outcomes = await readOutcomes({ home: tmpDir });
    expect(outcomes).toEqual([]);
  });
});

describe("readAggregates / writeAggregates", () => {
  const sampleAggregates: AggregateStats = {
    computedAt: "2026-03-22T12:00:00.000Z",
    totalActions: 100,
    totalOutcomes: 80,
    byActionType: {
      agent_reply: {
        count: 60,
        outcomeCount: 50,
        replyRate: 0.7,
        suppressionRate: 0.05,
      },
    },
    byHourOfDay: {
      10: { count: 20, replyRate: 0.8 },
    },
    byConsecutiveIgnores: {
      0: { count: 50, replyRate: 0.9 },
      1: { count: 20, replyRate: 0.5 },
    },
    byChannel: {
      telegram: { count: 100, replyRate: 0.75 },
    },
  };

  it("returns undefined when aggregates do not exist", async () => {
    const result = await readAggregates({ home: tmpDir });
    expect(result).toBeUndefined();
  });

  it("writes and reads aggregate stats", async () => {
    await writeAggregates(sampleAggregates, { home: tmpDir });

    const result = await readAggregates({ home: tmpDir });
    expect(result).toEqual(sampleAggregates);
  });

  it("overwrites existing aggregates atomically", async () => {
    await writeAggregates(sampleAggregates, { home: tmpDir });

    const updated: AggregateStats = {
      ...sampleAggregates,
      totalActions: 200,
      computedAt: "2026-03-22T13:00:00.000Z",
    };
    await writeAggregates(updated, { home: tmpDir });

    const result = await readAggregates({ home: tmpDir });
    expect(result?.totalActions).toBe(200);
    expect(result?.computedAt).toBe("2026-03-22T13:00:00.000Z");
  });

  it("supports per-agent aggregates", async () => {
    await writeAggregates(sampleAggregates, { agentId: "agent-x", home: tmpDir });

    // Global should be empty
    const globalResult = await readAggregates({ home: tmpDir });
    expect(globalResult).toBeUndefined();

    // Agent-scoped should have data
    const agentResult = await readAggregates({ agentId: "agent-x", home: tmpDir });
    expect(agentResult).toEqual(sampleAggregates);
  });
});

describe("directory creation", () => {
  it("creates nested directories on first write", async () => {
    const deepHome = path.join(tmpDir, "deep", "nested", "path");
    const record = makeActionRecord();
    await appendAction(record, { home: deepHome });

    const actions = await readActions({ home: deepHome });
    expect(actions).toHaveLength(1);
  });
});

describe("pruneOldRecords", () => {
  it("removes action records older than retention period", async () => {
    const oldRecord = makeActionRecord({
      id: "old-001",
      timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const recentRecord = makeActionRecord({
      id: "recent-001",
      timestamp: new Date().toISOString(),
    });

    await appendAction(oldRecord, { home: tmpDir });
    await appendAction(recentRecord, { home: tmpDir });

    const pruned = await pruneOldRecords(90, { home: tmpDir });
    expect(pruned).toBe(1);

    const remaining = await readActions({ home: tmpDir });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("recent-001");
  });

  it("removes outcome records older than retention period", async () => {
    const oldOutcome = makeOutcomeRecord({
      id: "old-out-001",
      timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const recentOutcome = makeOutcomeRecord({
      id: "recent-out-001",
      timestamp: new Date().toISOString(),
    });

    await appendOutcome(oldOutcome, { home: tmpDir });
    await appendOutcome(recentOutcome, { home: tmpDir });

    const pruned = await pruneOldRecords(90, { home: tmpDir });
    expect(pruned).toBe(1);

    const remaining = await readOutcomes({ home: tmpDir });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("recent-out-001");
  });

  it("returns 0 when no records exist", async () => {
    const pruned = await pruneOldRecords(90, { home: tmpDir });
    expect(pruned).toBe(0);
  });

  it("returns 0 when all records are within retention", async () => {
    const record = makeActionRecord({ timestamp: new Date().toISOString() });
    await appendAction(record, { home: tmpDir });

    const pruned = await pruneOldRecords(90, { home: tmpDir });
    expect(pruned).toBe(0);
  });
});
