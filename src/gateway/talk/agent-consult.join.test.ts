import { describe, expect, it } from "vitest";
import { joinOrStartTalkConsult, normalizeTalkConsultJoinRequest } from "./agent-consult.js";

const ok = (runId: string) => ({ ok: true as const, runId, idempotencyKey: runId });

describe("joinOrStartTalkConsult", () => {
  it("joins repeat calls to the in-flight consult instead of starting more", async () => {
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = new Set<string>();
    const call = () =>
      joinOrStartTalkConsult({
        key: "storm",
        request: "how many files",
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
        request: "how many files",
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

  it("starts a different request on its own and keeps the live run for its repeats", async () => {
    const live = new Set(["run-a"]);
    const starts: string[] = [];
    const refused = {
      ok: false as const,
      error: { code: "UNAVAILABLE", message: "Still working" } as never,
    };
    const call = (request: string, outcome: ReturnType<typeof ok> | typeof refused) =>
      joinOrStartTalkConsult({
        key: "distinct",
        request,
        isRunLive: (runId) => live.has(runId),
        start: async () => {
          starts.push(request);
          return outcome;
        },
      });
    expect(await call("count files", ok("run-a"))).toEqual(ok("run-a"));
    // A different question never receives run-a's answer. Its own start is refused by
    // chat admission while run-a is active.
    expect(await call("what is the date", refused)).toEqual(refused);
    expect(starts).toEqual(["count files", "what is the date"]);
    // The refused question did not displace the live run: its repeat still joins.
    expect(await call("count files", ok("run-unused"))).toEqual(ok("run-a"));
    expect(starts).toHaveLength(2);
    // A different question that does start becomes the run its own repeats join.
    live.add("run-b");
    expect(await call("what is the date", ok("run-b"))).toEqual(ok("run-b"));
    expect(await call("what is the date", ok("run-unused"))).toEqual(ok("run-b"));
    expect(starts).toHaveLength(3);
  });

  it("keeps a started different request joinable when the earlier run ended meanwhile", async () => {
    const live = new Set(["run-a"]);
    let finishB!: () => void;
    const startedB = new Promise<void>((resolve) => {
      finishB = resolve;
    });
    const refused = {
      ok: false as const,
      error: { code: "UNAVAILABLE", message: "Still working" } as never,
    };
    let starts = 0;
    const call = (request: string, start: () => Promise<ReturnType<typeof ok> | typeof refused>) =>
      joinOrStartTalkConsult({
        key: "interleaved",
        request,
        isRunLive: (runId) => live.has(runId),
        start: () => {
          starts += 1;
          return start();
        },
      });
    await call("question a", async () => ok("run-a"));
    // B starts while A is live, and is still starting when A ends and a repeat of A is refused.
    const pendingB = call("question b", async () => {
      await startedB;
      live.add("run-b");
      return ok("run-b");
    });
    await Promise.resolve();
    live.delete("run-a");
    expect(await call("question a", async () => refused)).toEqual(refused);
    finishB();
    expect(await pendingB).toEqual(ok("run-b"));
    // B's repeat joins B; it does not try another start.
    expect(await call("question b", async () => refused)).toEqual(ok("run-b"));
    expect(starts).toBe(3);
  });

  it("matches a repeat whatever its spacing or letter case, and nothing else", () => {
    const base = normalizeTalkConsultJoinRequest({ question: "How many files?" });
    expect(normalizeTalkConsultJoinRequest({ question: "  how many   FILES? " })).toBe(base);
    expect(normalizeTalkConsultJoinRequest({ question: "How many folders?" })).not.toBe(base);
    expect(
      normalizeTalkConsultJoinRequest({ question: "How many files?", context: "in docs" }),
    ).not.toBe(base);
  });
});
