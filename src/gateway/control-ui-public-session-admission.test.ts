import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";

const gates: ReturnType<typeof createControlUiPublicSessionRequestGate>[] = [];
const config = {};
function createGate() {
  const gate = createControlUiPublicSessionRequestGate();
  gates.push(gate);
  return gate;
}
function request(index = 0) {
  return {
    kind: "transcript" as const,
    publicationKey: `publication-${index}`,
    sessionKey: `agent:main:public-${index}`,
    requestKey: `page-${index}`,
    config,
  };
}
afterEach(() => {
  for (const gate of gates.splice(0)) {
    gate.dispose();
  }
  vi.restoreAllMocks();
});

describe("public reader admission", () => {
  it("serves twenty readers behind one IP with one render, including later refreshes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const gate = createGate();
    const render = createDeferred<string>();
    const work = vi.fn(() => render.promise);
    const pending = Array.from({ length: 20 }, () => {
      expect(gate.admitClient("shared-ip")).toEqual({ kind: "ok" });
      return gate.run({ ...request(), work });
    });
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    render.resolve("Public text");
    const results = await Promise.all(pending);
    expect(
      results.every((result) => result.kind === "ok" && result.value?.body === "Public text"),
    ).toBe(true);
    for (let refresh = 0; refresh < 80; refresh++) {
      expect(gate.admitClient("shared-ip")).toEqual({ kind: "ok" });
      expect((await gate.run({ ...request(), work })).kind).toBe("ok");
    }
    expect(work).toHaveBeenCalledTimes(1);

    const otherWork = vi.fn(async () => "Other configuration");
    expect(await gate.run({ ...request(), config: {}, work: otherWork })).toMatchObject({
      kind: "ok",
      value: { body: "Other configuration" },
    });
    expect(otherWork).toHaveBeenCalledTimes(1);
    expect(await gate.run({ ...request(), work })).toMatchObject({
      kind: "ok",
      value: { body: "Public text" },
    });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("queues twenty cold threads while retaining the eight-build budget", async () => {
    const gate = createGate();
    const release = createDeferred();
    let running = 0;
    let maximum = 0;
    const work = vi.fn(async () => {
      running++;
      maximum = Math.max(maximum, running);
      await release.promise;
      running--;
      return "Public text";
    });
    const pending = Array.from({ length: 20 }, (_, index) => gate.run({ ...request(index), work }));
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(8);
    release.resolve();
    const results = await Promise.all(pending);
    expect(results.every((result) => result.kind === "ok")).toBe(true);
    expect(work).toHaveBeenCalledTimes(20);
    expect(maximum).toBe(8);
  });

  it("bounds queued work and releases every waiter when its owner closes", async () => {
    const gate = createGate();
    const release = createDeferred<string>();
    const work = vi.fn(() => release.promise);
    const pending = Array.from({ length: 34 }, (_, index) =>
      gate.run({ ...request(), requestKey: `page-${index}`, work }),
    );
    expect(await gate.run({ ...request(), requestKey: "overflow", work })).toEqual({
      kind: "unavailable",
    });
    expect(work).toHaveBeenCalledTimes(2);
    gate.dispose();
    release.resolve("Closed content");
    const results = await Promise.all(pending);
    expect(results.every((result) => result.kind === "unavailable")).toBe(true);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("does not release stale content when publication changes during a build", async () => {
    const gate = createGate();
    const release = createDeferred<string>();
    const pending = gate.run({ ...request(), work: () => release.promise });
    await Promise.resolve();
    sessionChanges.emit({ sessionKey: request().sessionKey });
    release.resolve("Revoked content");
    expect(await pending).toEqual({ kind: "unavailable" });
  });

  it("keeps transcript builds current across run updates without sharing live card work", async () => {
    const gate = createGate();
    const transcript = createDeferred<string>();
    const card = createDeferred<string>();
    const transcriptWork = vi.fn(() => transcript.promise);
    const cardWork = vi.fn(() => card.promise);
    const page = gate.run({ ...request(), work: transcriptWork });
    const preview = gate.run({ ...request(), kind: "card", work: cardWork });
    await Promise.resolve();
    expect(transcriptWork).toHaveBeenCalledTimes(1);
    expect(cardWork).toHaveBeenCalledTimes(1);
    sessionChanges.emit({ sessionKey: request().sessionKey, scope: "runtime" });
    transcript.resolve("Published transcript");
    card.resolve("Outdated live status");
    expect(await page).toMatchObject({ kind: "ok", value: { body: "Published transcript" } });
    expect(await preview).toEqual({ kind: "unavailable" });
    const currentCard = await gate.run({ ...request(), kind: "card", work: cardWork });
    expect(currentCard.kind).toBe("ok");
    expect(cardWork).toHaveBeenCalledTimes(2);
    sessionChanges.emit({ all: true, scope: "subagent-runs" });
    expect(await gate.run({ ...request(), work: transcriptWork })).toMatchObject({
      kind: "ok",
      value: { body: "Published transcript" },
    });
    expect(transcriptWork).toHaveBeenCalledTimes(1);
    if (currentCard.kind !== "ok" || !currentCard.value) {
      throw new Error("Public card did not return its representation");
    }
    expect(currentCard.value.isCurrent()).toBe(false);
  });

  it("retains a late completion under byte pressure and evicts the least-recent result", async () => {
    const gate = createGate();
    const release = createDeferred<Buffer>();
    const body = Buffer.alloc(9 * 1024 * 1024, "a");
    const slowWork = vi.fn(() => release.promise);
    const slow = gate.run({ ...request(0), work: slowWork });
    const fast = await gate.run({
      ...request(1),
      work: async () => "Fast content".padEnd(9 * 1024 * 1024, "x"),
    });
    expect(fast.kind).toBe("ok");

    release.resolve(body);
    const completed = await slow;
    if (completed.kind !== "ok" || !completed.value || fast.kind !== "ok" || !fast.value) {
      throw new Error("Public builds did not return their representations");
    }
    expect(completed.value.body).toBe(body);
    expect(completed.value.isCurrent()).toBe(true);
    expect(fast.value.isCurrent()).toBe(false);
    const cached = await gate.run({ ...request(0), work: slowWork });
    expect(cached).toEqual({ kind: "ok", value: completed.value });
    expect(slowWork).toHaveBeenCalledTimes(1);

    // The late completion must count against the 16 MiB budget, not just survive eviction.
    const next = await gate.run({
      ...request(2),
      work: async () => Buffer.alloc(8 * 1024 * 1024, "b"),
    });
    expect(next.kind === "ok" && next.value?.isCurrent()).toBe(true);
    expect(completed.value.isCurrent()).toBe(false);
  });

  it("keeps client and publication rate budgets even for cached responses", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const gate = createGate();
    for (let index = 0; index < 120; index++) {
      expect(gate.admitClient("client").kind).toBe("ok");
    }
    expect(gate.admitClient("client").kind).toBe("rate-limited");
    const work = vi.fn(async () => "Cached");
    for (let index = 0; index < 240; index++) {
      expect((await gate.run({ ...request(), work })).kind).toBe("ok");
    }
    expect((await gate.run({ ...request(), work })).kind).toBe("rate-limited");
    expect(work).toHaveBeenCalledTimes(1);
  });
});
