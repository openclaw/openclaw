import { describe, expect, it } from "vitest";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";

describe("normalizeCronJobCreate sessionReuse", () => {
  it("coerces sessionReuse string true/false into boolean", () => {
    const createTrue = normalizeCronJobCreate({
      name: "cron true",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      sessionReuse: "true",
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(createTrue?.sessionReuse).toBe(true);

    const createFalse = normalizeCronJobCreate({
      name: "cron false",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      sessionReuse: "false",
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(createFalse?.sessionReuse).toBe(false);
  });

  it("drops invalid sessionReuse values", () => {
    const normalized = normalizeCronJobCreate({
      name: "cron invalid",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      sessionReuse: "unexpected",
      payload: { kind: "agentTurn", message: "hello" },
    }) as { sessionReuse?: unknown } | null;

    expect(normalized).not.toBeNull();
    expect("sessionReuse" in (normalized ?? {})).toBe(false);
  });
});

describe("normalizeCronJobPatch sessionReuse", () => {
  it("accepts boolean and string forms", () => {
    const patchTrue = normalizeCronJobPatch({ sessionReuse: true });
    expect(patchTrue?.sessionReuse).toBe(true);

    const patchFalse = normalizeCronJobPatch({ sessionReuse: "false" });
    expect(patchFalse?.sessionReuse).toBe(false);
  });
});
