import { describe, expect, it, vi } from "vitest";
import { recomputeSingleJobForMaintenance } from "./service/jobs-scheduling.js";
import { cronSourceIdentity, reconcileCronSourceIdentity } from "./source-schedule.js";
import type { CronJob, CronSchedule } from "./types.js";

describe("external automation source generations", () => {
  it("repairs and retains source identity without traversing event options", () => {
    const readOptions = vi.fn(() => ({ channel: "synthetic", topics: ["updates"] }));
    const job: CronJob = {
      id: "source-job",
      name: "source",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: {
        kind: "event",
        source: "synthetic",
        options: {
          get scope() {
            return readOptions();
          },
        },
      },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Report changes." },
      state: {},
    };
    const noop = () => {};
    const state = {
      deps: { nowMs: () => 1000, log: { debug: noop, info: noop, warn: noop, error: noop } },
    };
    const recompute = () =>
      recomputeSingleJobForMaintenance(
        state,
        job,
        { deferredNotifications: [] },
        {
          reservations: new Map(),
          isJobActive: () => false,
        },
      );

    expect(recompute()).toBe(true);
    const identity = job.state.sourceIdentity;
    expect(identity).toEqual(expect.any(String));
    expect(recompute()).toBe(false);
    expect(job.state.sourceIdentity).toBe(identity);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(readOptions).not.toHaveBeenCalled();
  });
  it.each<CronSchedule>([
    { kind: "event", source: "mcp-events", options: { name: "changed" } },
    { kind: "stream", command: ["source"] },
  ])("keeps an unchanged disabled $kind source and rotates it on re-enable", (schedule) => {
    const previous: CronJob = {
      id: "source-job",
      name: "source",
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Report changes." },
      state: {
        ...(schedule.kind === "stream"
          ? { streamSourceIdentity: "original" }
          : { sourceIdentity: "original" }),
        autoDisabled: { reason: "schedule-errors", atMs: 1, consecutiveErrors: 3 },
      },
    };
    const renamed = structuredClone(previous);
    renamed.name = "renamed";
    reconcileCronSourceIdentity(previous, renamed);
    expect(cronSourceIdentity(renamed)).toBe("original");

    const enabled = structuredClone(renamed);
    enabled.enabled = true;
    delete enabled.state.autoDisabled;
    reconcileCronSourceIdentity(renamed, enabled);
    expect(cronSourceIdentity(enabled)).not.toBe("original");
    expect(cronSourceIdentity(enabled)).toEqual(expect.any(String));
  });
});
