import { describe, expect, it } from "vitest";
import { cronSourceIdentity, reconcileCronSourceIdentity } from "./source-schedule.js";
import type { CronJob, CronSchedule } from "./types.js";

describe("external automation source generations", () => {
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
