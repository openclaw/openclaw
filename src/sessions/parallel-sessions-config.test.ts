import { describe, expect, it } from "vitest";
import {
  ParallelSessionsConfigSchema,
  DEFAULT_PARALLEL_SESSIONS_CONFIG,
} from "../config/parallel-sessions-config.js";

describe("ParallelSessionsConfigSchema", () => {
  it("applies all defaults when parsing empty object", () => {
    const result = ParallelSessionsConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.isolation).toBe("per-channel");
    expect(result.maxConcurrent).toBe(5);
    expect(result.idleTimeoutMs).toBe(300_000);
    expect(result.memory.backend).toBe("sqlite");
    expect(result.memory.enableWAL).toBe(true);
    expect(result.memory.autoPromoteThreshold).toBe(8);
    expect(result.briefing.enabled).toBe(true);
    expect(result.briefing.maxChannelMemories).toBe(10);
    expect(result.briefing.minConfidence).toBe(0.7);
    expect(result.autoSave.summaries).toBe(true);
  });

  it("parses a valid full config", () => {
    const input = {
      enabled: true,
      isolation: "per-peer" as const,
      maxConcurrent: 10,
      idleTimeoutMs: 60_000,
      memory: {
        backend: "memory" as const,
        dbPath: "/tmp/test.db",
        enableWAL: false,
        autoPromoteThreshold: 6,
        defaultTTLMs: 3600_000,
      },
      briefing: {
        enabled: false,
        maxChannelMemories: 20,
        maxGlobalKnowledge: 10,
        minImportance: 3,
        minConfidence: 0.5,
      },
      autoSave: {
        summaries: false,
        decisions: false,
        preferences: true,
        actionItems: false,
      },
      workExecutor: {
        enabled: true,
        pollIntervalMs: 2000,
        maxConcurrent: 3,
        executionTimeoutMs: 60000,
      },
    };

    const result = ParallelSessionsConfigSchema.parse(input);
    expect(result.enabled).toBe(true);
    expect(result.isolation).toBe("per-peer");
    expect(result.maxConcurrent).toBe(10);
    expect(result.memory.dbPath).toBe("/tmp/test.db");
    expect(result.memory.autoPromoteThreshold).toBe(6);
    expect(result.briefing.enabled).toBe(false);
    expect(result.autoSave.summaries).toBe(false);
    expect(result.workExecutor.enabled).toBe(true);
    expect(result.workExecutor.pollIntervalMs).toBe(2000);
    expect(result.workExecutor.maxConcurrent).toBe(3);
  });

  it("rejects maxConcurrent above 50", () => {
    expect(() => ParallelSessionsConfigSchema.parse({ maxConcurrent: 51 })).toThrow();
  });

  it("rejects maxConcurrent below 1", () => {
    expect(() => ParallelSessionsConfigSchema.parse({ maxConcurrent: 0 })).toThrow();
  });

  it("rejects invalid isolation level", () => {
    expect(() => ParallelSessionsConfigSchema.parse({ isolation: "per-planet" })).toThrow();
  });

  it("rejects idleTimeoutMs below minimum", () => {
    expect(() => ParallelSessionsConfigSchema.parse({ idleTimeoutMs: 100 })).toThrow();
  });

  it("rejects autoPromoteThreshold out of range", () => {
    expect(() =>
      ParallelSessionsConfigSchema.parse({ memory: { autoPromoteThreshold: 11 } }),
    ).toThrow();
    expect(() =>
      ParallelSessionsConfigSchema.parse({ memory: { autoPromoteThreshold: 0 } }),
    ).toThrow();
  });

  it("DEFAULT_PARALLEL_SESSIONS_CONFIG round-trips through schema", () => {
    const result = ParallelSessionsConfigSchema.parse(DEFAULT_PARALLEL_SESSIONS_CONFIG);
    expect(result).toEqual(DEFAULT_PARALLEL_SESSIONS_CONFIG);
  });

  it("default paths reference ~/.openclaw, not ~/.clawdbot", () => {
    // The dbPath comment / docs should not reference the old product name
    expect(DEFAULT_PARALLEL_SESSIONS_CONFIG.memory.dbPath).toBeUndefined();
  });

  // ── Work Executor Config ──

  it("workExecutor defaults applied", () => {
    const result = ParallelSessionsConfigSchema.parse({});
    expect(result.workExecutor.enabled).toBe(false);
    expect(result.workExecutor.pollIntervalMs).toBe(5000);
    expect(result.workExecutor.maxConcurrent).toBe(1);
    expect(result.workExecutor.executionTimeoutMs).toBe(300000);
  });

  it("workExecutor custom config parsed", () => {
    const result = ParallelSessionsConfigSchema.parse({
      workExecutor: {
        enabled: true,
        pollIntervalMs: 10000,
        maxConcurrent: 5,
        executionTimeoutMs: 600000,
      },
    });
    expect(result.workExecutor.enabled).toBe(true);
    expect(result.workExecutor.pollIntervalMs).toBe(10000);
    expect(result.workExecutor.maxConcurrent).toBe(5);
    expect(result.workExecutor.executionTimeoutMs).toBe(600000);
  });

  it("workExecutor rejects pollIntervalMs below 1000", () => {
    expect(() =>
      ParallelSessionsConfigSchema.parse({ workExecutor: { pollIntervalMs: 500 } }),
    ).toThrow();
  });

  it("workExecutor rejects maxConcurrent above 10", () => {
    expect(() =>
      ParallelSessionsConfigSchema.parse({ workExecutor: { maxConcurrent: 11 } }),
    ).toThrow();
  });

  it("DEFAULT_PARALLEL_SESSIONS_CONFIG includes workExecutor", () => {
    expect(DEFAULT_PARALLEL_SESSIONS_CONFIG.workExecutor).toBeDefined();
    expect(DEFAULT_PARALLEL_SESSIONS_CONFIG.workExecutor.enabled).toBe(false);
    expect(DEFAULT_PARALLEL_SESSIONS_CONFIG.workExecutor.pollIntervalMs).toBe(5000);
  });
});
