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
