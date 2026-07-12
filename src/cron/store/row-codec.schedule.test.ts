// Round-trips each CronSchedule kind through the SQLite column codec so the
// on-exit command/cwd persistence (v1 reuses schedule_expr/schedule_tz) is
// covered alongside the existing kinds.
import { describe, expect, it } from "vitest";
import type { CronSchedule } from "../types.js";
import { bindScheduleColumns, scheduleFromRow } from "./row-codec.js";
import type { CronJobRow } from "./schema.js";

function roundTrip(schedule: CronSchedule): CronSchedule | null {
  const cols = bindScheduleColumns(schedule);
  // scheduleFromRow only reads the schedule_* / at / every_ms / anchor_ms /
  // stagger_ms columns; the rest of the row is irrelevant here.
  return scheduleFromRow(cols as unknown as CronJobRow);
}

describe("schedule column codec round-trip", () => {
  it("round-trips an on-exit schedule with command + cwd", () => {
    expect(roundTrip({ kind: "on-exit", command: "make build", cwd: "/repo" })).toEqual({
      kind: "on-exit",
      command: "make build",
      cwd: "/repo",
    });
  });

  it("round-trips an on-exit schedule without cwd", () => {
    expect(roundTrip({ kind: "on-exit", command: "./watch.sh" })).toEqual({
      kind: "on-exit",
      command: "./watch.sh",
    });
  });

  it("keeps existing kinds intact (no cross-talk from on-exit column reuse)", () => {
    expect(roundTrip({ kind: "every", everyMs: 60_000 })).toEqual({
      kind: "every",
      everyMs: 60_000,
    });
    expect(roundTrip({ kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" })).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
    });
    expect(roundTrip({ kind: "at", at: "2026-01-01T00:00:00.000Z" })).toEqual({
      kind: "at",
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("an on-exit row is decoded as on-exit, not cron (schedule_kind disambiguates)", () => {
    const cols = bindScheduleColumns({ kind: "on-exit", command: "sleep 5" });
    expect(cols.schedule_kind).toBe("on-exit");
    const decoded = scheduleFromRow(cols as unknown as CronJobRow);
    expect(decoded?.kind).toBe("on-exit");
  });
});
