import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { schedulesEqual } from "./schedule-equality.js";

describe("schedulesEqual", () => {
  it("treats equivalent at timestamps as equal", () => {
    expect(
      schedulesEqual(
        { kind: "at", at: "2026-03-19T12:00:00Z" },
        { kind: "at", at: "2026-03-19T07:00:00-05:00" },
      ),
    ).toBe(true);
  });

  it("treats normalized every schedules as equal", () => {
    expect(
      schedulesEqual(
        { kind: "every", everyMs: 60_000.9, anchorMs: 1_234.8 } as CronJob["schedule"],
        { kind: "every", everyMs: 60_000, anchorMs: 1_234 } as CronJob["schedule"],
      ),
    ).toBe(true);
  });

  it("keeps materially different every schedules distinct", () => {
    expect(
      schedulesEqual(
        { kind: "every", everyMs: 60_000, anchorMs: 1_234 },
        { kind: "every", everyMs: 120_000, anchorMs: 1_234 },
      ),
    ).toBe(false);
  });
});
