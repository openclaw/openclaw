import { describe, expect, it } from "vitest";
import { joinOrStartTalkConsult } from "./agent-consult.js";

const ok = (runId: string) => ({ ok: true as const, runId, idempotencyKey: runId });

describe("joinOrStartTalkConsult", () => {
  it("joins repeat calls to the in-flight consult instead of starting more", async () => {
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const live = new Set<string>();
    const call = () =>
      joinOrStartTalkConsult({
        key: "storm",
        isRunLive: (runId) => live.has(runId),
        start: async () => {
          const runId = `run-${++starts}`;
          await gate;
          live.add(runId);
          return ok(runId);
        },
      });
    // 16 repeats while the first start is still unacknowledged.
    const pending = Array.from({ length: 16 }, call);
    release();
    const results = await Promise.all(pending);
    expect(starts).toBe(1);
    expect(new Set(results.map((r) => (r.ok ? r.runId : "failed")))).toEqual(new Set(["run-1"]));
    // Still running: a later repeat joins too.
    expect(await call()).toEqual(ok("run-1"));
    expect(starts).toBe(1);
    // Run finished: the next question starts a new consult.
    live.clear();
    expect(await call()).toEqual(ok("run-2"));
    expect(starts).toBe(2);
  });

  it("does not cache a failed start, and waiters share one retry", async () => {
    let starts = 0;
    const live = new Set<string>();
    const call = () =>
      joinOrStartTalkConsult({
        key: "retry",
        isRunLive: (runId) => live.has(runId),
        start: async () => {
          starts += 1;
          await Promise.resolve();
          if (starts === 1) {
            return { ok: false as const, error: { code: "UNAVAILABLE", message: "busy" } as never };
          }
          live.add("run-ok");
          return ok("run-ok");
        },
      });
    const results = await Promise.all([call(), call(), call()]);
    expect(starts).toBe(2);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
});
