import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { createEnginePageScenarios } from "../../scripts/lib/control-ui-engine-page-scenarios.ts";

it.each([
  { id: "page-cron-visit", origin: "new-session" },
  { id: "page-cloud-workers-revisit", origin: "new-session" },
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
