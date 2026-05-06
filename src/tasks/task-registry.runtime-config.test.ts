import { afterEach, describe, expect, it } from "vitest";
import {
  applyTasksConfig,
  DEFAULT_TASK_RETENTION_MS,
  DEFAULT_TASK_SWEEP_INTERVAL_MS,
  getTaskRetentionMs,
  getTaskSweepIntervalMs,
  resetTaskRegistryRuntimeConfigForTests,
} from "./task-registry.runtime-config.js";

describe("task registry runtime config", () => {
  afterEach(() => {
    resetTaskRegistryRuntimeConfigForTests();
  });

  it("returns defaults when no config is supplied", () => {
    applyTasksConfig(undefined);
    expect(getTaskRetentionMs()).toBe(DEFAULT_TASK_RETENTION_MS);
    expect(getTaskSweepIntervalMs()).toBe(DEFAULT_TASK_SWEEP_INTERVAL_MS);
  });

  it("applies configured retention and sweep interval", () => {
    applyTasksConfig({ retentionMs: 3_600_000, sweepIntervalMs: 30_000 });
    expect(getTaskRetentionMs()).toBe(3_600_000);
    expect(getTaskSweepIntervalMs()).toBe(30_000);
  });

  it("falls back to defaults for invalid or non-positive values", () => {
    applyTasksConfig({ retentionMs: 0, sweepIntervalMs: -5 });
    expect(getTaskRetentionMs()).toBe(DEFAULT_TASK_RETENTION_MS);
    expect(getTaskSweepIntervalMs()).toBe(DEFAULT_TASK_SWEEP_INTERVAL_MS);
  });

  it("falls back to defaults for non-finite values", () => {
    applyTasksConfig({
      retentionMs: Number.NaN,
      sweepIntervalMs: Number.POSITIVE_INFINITY,
    });
    expect(getTaskRetentionMs()).toBe(DEFAULT_TASK_RETENTION_MS);
    expect(getTaskSweepIntervalMs()).toBe(DEFAULT_TASK_SWEEP_INTERVAL_MS);
  });

  it("truncates fractional values toward integers", () => {
    applyTasksConfig({ retentionMs: 12345.789, sweepIntervalMs: 99.9 });
    expect(getTaskRetentionMs()).toBe(12345);
    expect(getTaskSweepIntervalMs()).toBe(99);
  });

  it("is idempotent on repeated apply calls", () => {
    applyTasksConfig({ retentionMs: 1234 });
    applyTasksConfig({ retentionMs: 1234 });
    expect(getTaskRetentionMs()).toBe(1234);
  });
});
