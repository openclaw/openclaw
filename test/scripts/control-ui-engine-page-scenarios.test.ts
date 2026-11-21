import { runInNewContext } from "node:vm";
import type { Locator, Page } from "playwright";
import { expect, it, vi } from "vitest";
import { createEnginePageScenarios } from "../../scripts/lib/control-ui-engine-page-scenarios.ts";
import { createMockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-controls.ts";

it.each([
  { id: "page-cron-visit", origin: "new-session" },
  { id: "page-cloud-workers-revisit", origin: "new-session" },
  { id: "page-custodian-greeting-visit", origin: "new-session" },
  { id: "page-terminal-first-create-visit", origin: "new-session" },
  { id: "page-terminal-first-attach-visit", origin: "new-session" },
  { id: "page-terminal-first-output-revisit", origin: "new-session" },
  { id: "page-terminal-cold-visit", origin: "new-session" },
  { id: "page-terminal-cold-attach-visit", origin: "new-session" },
  { id: "page-cron-visit", origin: "chat" },
] as const)(
  "$id from $origin applies the selected Gateway latency once to each delivered frame",
  ({ id, origin }) => {
    const scenario = createEnginePageScenarios(100, origin, "http://127.0.0.1").find(
      (entry) => entry.id === id,
    );
    expect(scenario?.initScript).toBeDefined();
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let now = 0;
    class Socket extends EventTarget {
      send() {}
    }
    const realm = {
      WebSocket: Socket,
      WeakMap,
      MessageEvent,
      TextEncoder,
      performance: { now: () => now, mark() {} },
      PerformanceObserver: class {
        observe() {}
      },
      addEventListener() {},
      requestAnimationFrame() {},
      setTimeout(callback: () => void, delay: number) {
        timers.push({ callback, delay });
      },
    };
    Object.assign(realm, { top: realm });
    runInNewContext(scenario!.initScript!, {
      ...realm,
      window: realm,
      location: { protocol: "http:" },
    });
    const socket = new realm.WebSocket();
    const delivered: string[] = [];
    socket.addEventListener("message", (event) => {
      if (event instanceof MessageEvent) {
        delivered.push(event.data);
      }
    });
    const frames = [
      { type: "event", event: "connect.challenge", payload: { nonce: "synthetic" } },
      { type: "res", id: "read", ok: true, payload: {} },
    ].map((frame) => JSON.stringify(frame));
    for (const data of frames) {
      socket.dispatchEvent(new MessageEvent("message", { data }));
    }
    expect(delivered).toEqual([]);
    expect(timers.map(({ delay }) => delay)).toEqual([100, 100]);
    now = 100;
    for (const { callback } of timers.splice(0)) {
      callback();
    }
    expect(delivered).toEqual(frames);
    expect(timers).toEqual([]);
  },
);

it.each([
  { scrollPaddingTop: "64px", intermediateTop: 20, destinationTop: 84 },
  { scrollPaddingTop: "auto", intermediateTop: 180, destinationTop: 20 },
])(
  "Config readiness waits for the settled $scrollPaddingTop scroll-padding destination",
  async ({ scrollPaddingTop, intermediateTop, destinationTop }) => {
    const scenario = createEnginePageScenarios().find((entry) => entry.id === "page-config-visit")!;
    const frames: Array<(time: number) => void> = [];
    let now = 0;
    let anchorTop = intermediateTop;
    const scrollport = {
      getBoundingClientRect: () => ({ top: 20 }),
      scrollHeight: 2_000,
      clientHeight: 800,
      scrollTop: 100,
    };
    const realm = {
      __name: (callback: unknown) => callback,
      window: {
        innerHeight: 844,
        openclawControlUi: {
          navigate() {},
          snapshot: () => ({
            routeReady: true,
            route: { status: "success", matches: [{ routeId: "appearance" }], pendingMatches: [] },
          }),
        },
      },
      document: {
        getElementById: (id: string) =>
          id === "control-ui-main"
            ? scrollport
            : { getBoundingClientRect: () => ({ top: anchorTop }) },
        querySelectorAll: () => [{ checkVisibility: () => true }],
      },
      getComputedStyle: () => ({ scrollPaddingTop }),
      performance: { now: () => now },
      requestAnimationFrame: (callback: (time: number) => void) => frames.push(callback),
    };
    const evaluate = vi.fn().mockResolvedValue(16);
    evaluate.mockImplementationOnce((callback: (input: unknown) => unknown, input: unknown) =>
      runInNewContext(`(${callback.toString()})(input)`, { ...realm, input }),
    );
    const locator = {
      filter: () => locator,
      first: () => locator,
      waitFor: async () => {},
    } as Locator;
    const pageMethods: Pick<Page, "evaluate" | "waitForFunction" | "locator"> = {
      evaluate,
      waitForFunction: vi.fn().mockResolvedValue({ dispose: async () => {} }),
      locator: () => locator,
    };
    // SAFETY: Run the production readiness callback; later Playwright waits are outside its clock.
    const page = pageMethods as Page;
    const measurement = scenario.run(page, createMockGatewayControls(page, "synthetic", [], {}));
    const advance = () => {
      now += 16;
      const callback = frames.shift();
      expect(callback).toBeDefined();
      callback!(now);
    };

    // Even three stationary frames are insufficient at the wrong destination.
    advance();
    advance();
    advance();
    expect(frames).toHaveLength(1);
    anchorTop = destinationTop;
    advance();
    advance();
    expect(frames).toHaveLength(1);
    advance();
    expect(frames).toHaveLength(0);
    expect(await measurement).toMatchObject({ visitReadyMs: 32, contentReadyMs: 96 });
  },
);
