import { describe, expect, it } from "vitest";
import { normalizeStoredCronJobs } from "./store-migration.js";

function storedJob(sessionTarget: string | undefined): Record<string, unknown> {
  return {
    id: "session-target",
    name: "Session target",
    enabled: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    sessionTarget,
    sessionKey: "agent:main:dashboard:source",
    owner: { agentId: "main", sessionKey: "agent:main:dashboard:source" },
    schedule: { kind: "every", everyMs: 120_000, anchorMs: 1 },
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Report the result." },
    delivery: { mode: "announce" },
    trigger: { script: "return { fire: false };" },
    state: { consecutiveErrors: 2 },
  };
}

describe("stored cron session targets", () => {
  it.each([undefined, null, "", " \t ", 42])(
    "keeps the isolated fallback for current without a usable binding: %s",
    (sessionKey) => {
      const job = { ...storedJob("current"), sessionKey };
      const expected = {
        ...structuredClone(job),
        sessionTarget: "isolated",
        sessionKey: undefined,
      };

      const result = normalizeStoredCronJobs([job]);

      expect(result.jobs).toEqual([expected]);
      expect(result.mutated).toBe(true);
      expect(normalizeStoredCronJobs(result.jobs).mutated).toBe(false);
    },
  );

  it.each(["current", "isolated", "session:ProjectAlpha"])(
    "preserves the canonical %s target and bound job without requesting a rewrite",
    (target) => {
      const job = storedJob(target);
      const before = structuredClone(job);

      const result = normalizeStoredCronJobs([job]);

      expect(result.mutated).toBe(false);
      expect(result.jobs).toEqual([before]);
      expect(result.removedJobs).toEqual([]);
    },
  );

  it.each([
    [" CURRENT ", "current"],
    [" ISOLATED ", "isolated"],
    [" SESSION: ProjectAlpha ", "session:ProjectAlpha"],
    [undefined, "isolated"],
  ])("normalizes %s without changing its meaning", (input, target) => {
    const job = storedJob(input);
    const expected = { ...structuredClone(job), sessionTarget: target };

    const result = normalizeStoredCronJobs([job]);

    expect(result.mutated).toBe(true);
    expect(result.jobs).toEqual([expected]);
    expect(normalizeStoredCronJobs(result.jobs).mutated).toBe(false);
  });
});
