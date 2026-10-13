import { describe, expect, it } from "vitest";
import { maybeAutoDisableCronJobAfterRunFailure } from "../../../cron/service/auto-disable.js";
import type { CronJob } from "../../../cron/types.js";
import { normalizeStoredCronJobs } from "./store-migration.js";

const LEGACY_INTERRUPTED_ERROR = "cron: job interrupted by gateway restart";
const CREATED_AT_MS = 1_700_000_000_000;

function legacyJob(state: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "upgraded",
    name: "upgraded",
    enabled: true,
    createdAtMs: CREATED_AT_MS,
    updatedAtMs: CREATED_AT_MS,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: "tick" },
    state,
  };
}

function normalizeLegacyRow(state: Record<string, unknown>) {
  const jobs = [legacyJob(state)];
  const result = normalizeStoredCronJobs(jobs);
  const row = jobs[0] ?? {};
  return {
    result,
    state: (row.state ?? {}) as Record<string, unknown>,
    // Doctor repairs raw rows; the scheduler then loads the repaired row from
    // the same store, so the real policy owner is asked about it directly.
    job: row as unknown as CronJob,
  };
}

function askAutoDisable(job: CronJob): boolean {
  return maybeAutoDisableCronJobAfterRunFailure({
    job,
    atMs: CREATED_AT_MS + 60_000,
    deferredNotifications: [],
  });
}

describe("legacy cron restart-interruption normalization", () => {
  it("records the one interruption a legacy failure streak still proves", () => {
    // v2026.9.9 shape: genuine failures plus a restart, with no offset.
    const { result, state } = normalizeLegacyRow({
      consecutiveErrors: 9,
      lastRunStatus: "error",
      lastError: LEGACY_INTERRUPTED_ERROR,
    });

    expect(state.consecutiveRestartInterruptions).toBe(1);
    expect(state.lastRunInterruptionReason).toBe("gateway-restart");
    expect(result.issues.legacyRestartInterruption).toBe(1);
    expect(result.mutated).toBe(true);
  });

  it("keeps the tenth failure slot unspent for an upgraded row", () => {
    // Nine genuine failures plus one known interruption. Without the offset the
    // budget sees ten and disables a healthy job one real failure early.
    const { job } = normalizeLegacyRow({
      consecutiveErrors: 10,
      lastError: LEGACY_INTERRUPTED_ERROR,
    });

    expect(askAutoDisable(job)).toBe(false);
  });

  it("still auto-disables an upgraded row on its tenth genuine failure", () => {
    const { job } = normalizeLegacyRow({
      consecutiveErrors: 11,
      lastError: LEGACY_INTERRUPTED_ERROR,
    });

    expect(askAutoDisable(job)).toBe(true);
  });

  it("leaves a recorded offset alone", () => {
    const { result, state } = normalizeLegacyRow({
      consecutiveErrors: 9,
      consecutiveRestartInterruptions: 4,
      lastError: LEGACY_INTERRUPTED_ERROR,
    });

    expect(state.consecutiveRestartInterruptions).toBe(4);
    expect(result.issues.legacyRestartInterruption).toBeUndefined();
  });

  it.each([
    ["no retained streak", { consecutiveErrors: 0, lastError: LEGACY_INTERRUPTED_ERROR }],
    ["no streak counter", { lastError: LEGACY_INTERRUPTED_ERROR }],
    ["a genuine last error", { consecutiveErrors: 9, lastError: "provider refused the request" }],
  ])("attributes nothing to a restart with %s", (_name, rawState) => {
    const { result, state } = normalizeLegacyRow(rawState);

    expect(state.consecutiveRestartInterruptions).toBeUndefined();
    expect(state.lastRunInterruptionReason).toBeUndefined();
    expect(result.issues.legacyRestartInterruption).toBeUndefined();
  });
});
