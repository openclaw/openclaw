import { describe, expect, it } from "vitest";
import { normalizeStoredCronJobs } from "./store-migration.js";

const sourceSessionKey = "agent:main:dashboard:source";

describe("stored cron session targets", () => {
  it.each([
    ["current", undefined, "isolated", undefined],
    ["current", " \t ", "isolated", undefined],
    ["current", 42, "isolated", undefined],
    [" CURRENT ", sourceSessionKey, "current", sourceSessionKey],
    [" ISOLATED ", sourceSessionKey, "isolated", sourceSessionKey],
    [" SESSION: ProjectAlpha ", sourceSessionKey, "session:ProjectAlpha", sourceSessionKey],
    [undefined, sourceSessionKey, "isolated", sourceSessionKey],
  ])(
    "normalizes target %s with binding %s without changing the rest of the job",
    (sessionTarget, sessionKey, target, binding) => {
      const job = {
        id: "session-target",
        name: "Session target",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        sessionTarget,
        sessionKey,
        owner: { agentId: "main", sessionKey: sourceSessionKey },
        schedule: { kind: "every", everyMs: 120_000, anchorMs: 1 },
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Report the result." },
        delivery: { mode: "announce" },
        trigger: { script: "return { fire: false };" },
        state: { consecutiveErrors: 2 },
      };
      const expected = {
        ...structuredClone(job),
        sessionTarget: target,
        sessionKey: binding,
      };

      const result = normalizeStoredCronJobs([job]);

      expect(result.jobs).toEqual([expected]);
      expect(result.mutated).toBe(true);
      const canonical = normalizeStoredCronJobs(result.jobs);
      expect(canonical.mutated).toBe(false);
      expect(canonical.jobs).toEqual([expected]);
      expect(canonical.removedJobs).toEqual([]);
    },
  );
});
