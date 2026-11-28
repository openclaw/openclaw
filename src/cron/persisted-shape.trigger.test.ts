import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    schedule: { kind: "every", everyMs: 30_000 },
    check: { script: "json({ wake: '' })" },
    payload: { kind: "agentTurn", message: "changed" },
    sessionTarget: "main",
    ...overrides,
  };
}

describe("persisted cron trigger shape", () => {
  it("accepts a non-empty trigger on recurring schedules", () => {
    expect(getInvalidPersistedCronJobReason(candidate())).toBeNull();
    expect(
      getInvalidPersistedCronJobReason(
        candidate({ schedule: { kind: "cron", expr: "* * * * *" } }),
      ),
    ).toBeNull();
  });

  it("rejects empty scripts and non-object triggers", () => {
    expect(getInvalidPersistedCronJobReason(candidate({ check: { script: "  " } }))).toBe(
      "invalid-check",
    );
    expect(getInvalidPersistedCronJobReason(candidate({ check: "script" }))).toBe("invalid-check");
  });

  it("rejects triggers on at and on-exit schedules", () => {
    expect(
      getInvalidPersistedCronJobReason(
        candidate({ schedule: { kind: "at", at: "2026-08-01T00:00:00.000Z" } }),
      ),
    ).toBe("invalid-check");
    expect(
      getInvalidPersistedCronJobReason(
        candidate({ schedule: { kind: "on-exit", command: "make build" } }),
      ),
    ).toBe("invalid-check");
  });
});
