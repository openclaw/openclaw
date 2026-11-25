import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import type { PublicSessionRepresentation } from "./control-ui-public-session-cache.js";

let gate: ReturnType<typeof createControlUiPublicSessionRequestGate>;
const config = {};
beforeEach(() => {
  gate = createControlUiPublicSessionRequestGate();
});
function request(index = 0) {
  return {
    kind: "transcript" as const,
    publicationKey: `publication-${index}`,
    sessionKey: `agent:main:public-${index}`,
    requestKey: `page-${index}`,
    config,
    consume: (value: PublicSessionRepresentation | null) => value,
  };
}
afterEach(() => {
  gate.dispose();
  vi.restoreAllMocks();
});

const rendered = (body: string) => ({ kind: "ok", value: { body } });

describe("public reader admission", () => {
  it("shares a superseded render and its replacement across twenty readers and later refreshes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const render = createDeferred<string>();
    const work = vi.fn().mockReturnValueOnce(render.promise).mockResolvedValue("Public text");
    const pending = Array.from({ length: 20 }, () => {
      expect(gate.admitClient("shared-ip")).toEqual({ kind: "ok" });
      return gate.run({ ...request(), work });
    });
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    sessionChanges.emit({ sessionKey: request().sessionKey, scope: "session-entry" });
    render.resolve("Superseded text");
    const results = await Promise.all(pending);
    expect(
      results.every((result) => result.kind === "ok" && result.value?.body === "Public text"),
    ).toBe(true);
    for (let refresh = 0; refresh < 80; refresh++) {
      expect(gate.admitClient("shared-ip")).toEqual({ kind: "ok" });
      expect((await gate.run({ ...request(), work })).kind).toBe("ok");
    }
    expect(work).toHaveBeenCalledTimes(2);

    const otherWork = vi.fn(async () => "Other configuration");
    expect(await gate.run({ ...request(), config: {}, work: otherWork })).toMatchObject(
      rendered("Other configuration"),
    );
    expect(otherWork).toHaveBeenCalledTimes(1);
    expect(await gate.run({ ...request(), work })).toMatchObject(rendered("Public text"));
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("stops rebuilding when the HTTP work scope closes", async () => {
    const scope = new AsyncWorkScope();
    const release = createDeferred<string>();
    const work = vi.fn(() => release.promise);
    const consume = vi.fn(request().consume);
    const pending = scope.run(() => gate.run({ ...request(), work, consume }));
    await Promise.resolve();
    sessionChanges.emit({ sessionKey: request().sessionKey });
    scope.beginClose(new Error("HTTP reader disconnected"));
    release.resolve("Superseded text");
    await expect(pending).rejects.toThrow("HTTP reader disconnected");
    await scope.drain();
    expect(work).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(await gate.run({ ...request(), work: async () => "Fresh text" })).toMatchObject(
      rendered("Fresh text"),
    );
  });

  it("does not repeatedly render content too large for the cache", async () => {
    const work = vi.fn(async () => Buffer.alloc(17 * 1024 * 1024));
    expect(await gate.run({ ...request(), work })).toEqual({ kind: "unavailable" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("lets a live reader replace a superseded render after its initiator disconnects", async () => {
    const initiator = new AsyncWorkScope();
    const survivor = new AsyncWorkScope();
    const release = createDeferred<string>();
    const work = vi.fn().mockReturnValueOnce(release.promise).mockResolvedValue("Fresh text");
    const first = initiator.run(() => gate.run({ ...request(), work }));
    const rejected = expect(first).rejects.toThrow("HTTP reader disconnected");
    const second = survivor.run(() => gate.run({ ...request(), work }));
    await Promise.resolve();
    sessionChanges.emit({ sessionKey: request().sessionKey });
    initiator.beginClose(new Error("HTTP reader disconnected"));
    release.resolve("Superseded text");
    await rejected;
    await expect(second).resolves.toMatchObject(rendered("Fresh text"));
    expect(work).toHaveBeenCalledTimes(2);
    await Promise.all([initiator.drain(), survivor.drain()]);
  });

  it("queues twenty cold threads while retaining the eight-build budget", async () => {
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
    const release = createDeferred<string>();
    const work = vi.fn().mockReturnValueOnce(release.promise).mockResolvedValue(null);
    const pending = gate.run({ ...request(), work });
    await Promise.resolve();
    sessionChanges.emit({ sessionKey: request().sessionKey });
    release.resolve("Revoked content");
    expect(await pending).toEqual({ kind: "ok", value: null });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("keeps transcript builds current across run updates without sharing live card work", async () => {
    const transcript = createDeferred<string>();
    const card = createDeferred<string>();
    const transcriptWork = vi.fn(() => transcript.promise);
    const cardWork = vi
      .fn()
      .mockReturnValueOnce(card.promise)
      .mockResolvedValue("Current live status");
    const page = gate.run({ ...request(), work: transcriptWork });
    const preview = gate.run({ ...request(), kind: "card", work: cardWork });
    await Promise.resolve();
    expect(transcriptWork).toHaveBeenCalledTimes(1);
    expect(cardWork).toHaveBeenCalledTimes(1);
    sessionChanges.emit({ sessionKey: request().sessionKey, scope: "runtime" });
    transcript.resolve("Published transcript");
    card.resolve("Outdated live status");
    expect(await page).toMatchObject(rendered("Published transcript"));
    expect(await preview).toMatchObject(rendered("Current live status"));
    const currentCard = await gate.run({ ...request(), kind: "card", work: cardWork });
    expect(currentCard.kind).toBe("ok");
    expect(cardWork).toHaveBeenCalledTimes(2);
    sessionChanges.emit({ all: true, scope: "subagent-runs" });
    expect(await gate.run({ ...request(), work: transcriptWork })).toMatchObject(
      rendered("Published transcript"),
    );
    expect(transcriptWork).toHaveBeenCalledTimes(1);
    assert(currentCard.kind === "ok" && currentCard.value);
    expect(currentCard.value.isCurrent()).toBe(false);
  });

  it("retains a late completion under byte pressure and evicts the least-recent result", async () => {
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
    assert(completed.kind === "ok" && completed.value && fast.kind === "ok" && fast.value);
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
    for (let index = 0; index < 120; index++) {
      expect(gate.admitClient("client").kind).toBe("ok");
    }
    expect(gate.admitClient("client").kind).toBe("rate-limited");
    const work = vi.fn(async () => {
      if (work.mock.calls.length === 1) {
        sessionChanges.emit({ sessionKey: request().sessionKey });
      }
      return "Cached";
    });
    for (let index = 0; index < 240; index++) {
      expect((await gate.run({ ...request(), work })).kind).toBe("ok");
    }
    expect((await gate.run({ ...request(), work })).kind).toBe("rate-limited");
    expect(work).toHaveBeenCalledTimes(2);
  });
});
