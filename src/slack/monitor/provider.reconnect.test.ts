import { afterEach, describe, expect, it } from "vitest";
import "../monitor.test-helpers.js";
import {
  flush,
  getSlackAppInstances,
  getSlackTestState,
  resetSlackTestState,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

const FAST_RECONNECT = {
  initialMs: 0,
  maxMs: 0,
  factor: 1,
  jitter: 0,
  maxAttempts: 3,
};

function makeOpts(overrides?: Record<string, unknown>) {
  const controller = new AbortController();
  return {
    controller,
    opts: {
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      tuning: {
        sleep: () => Promise.resolve(),
        reconnect: FAST_RECONNECT,
      },
      ...overrides,
    },
  };
}

afterEach(() => {
  resetSlackTestState();
});

describe("slack socket mode reconnect", () => {
  it("reconnects after socket disconnect", async () => {
    const { controller, opts } = makeOpts();
    const run = monitorSlackProvider(opts);

    // Wait for first connection to establish.
    await flush();
    await flush();
    const instances = getSlackAppInstances();
    expect(instances.length).toBeGreaterThanOrEqual(1);

    // Trigger disconnect on the connected instance (last one with error handler).
    const connectedApp = instances[instances.length - 1];
    connectedApp.__triggerError(new Error("socket closed"));

    // Wait for reconnect attempt.
    await flush();
    await flush();

    // Abort to exit the loop cleanly.
    controller.abort();
    await run;

    // A second App instance should have been created for the reconnect.
    expect(instances.length).toBeGreaterThanOrEqual(2);
  });

  it("stops after max reconnect attempts on start failure", async () => {
    const { opts } = makeOpts();

    // Make every App's start() reject.
    const origInstances = getSlackAppInstances();
    const startInterceptor = setInterval(() => {
      for (const app of origInstances) {
        if (!app.start.mock.results.length) {
          app.start.mockRejectedValueOnce(new Error("connection refused"));
        }
      }
    }, 0);

    // Simpler: patch start before instances are created by hooking into the array.
    clearInterval(startInterceptor);

    // We need start to fail. The mock returns resolved by default.
    // Override at the globalThis level: make every new App's start fail.
    const tracker = getSlackAppInstances();
    const origPush = tracker.push.bind(tracker);
    let pushCount = 0;
    tracker.push = function (...apps) {
      for (const app of apps) {
        pushCount += 1;
        app.start.mockRejectedValue(new Error("connection refused"));
      }
      return origPush(...apps);
    };

    const run = monitorSlackProvider(opts);
    await run;

    tracker.push = origPush;
    // probe app + placeholder ctx app + maxAttempts reconnect apps
    expect(pushCount).toBe(FAST_RECONNECT.maxAttempts + 2);
  });

  it("aborts cleanly during backoff sleep", async () => {
    const { controller, opts } = makeOpts({
      tuning: {
        sleep: async (_ms: number, signal?: AbortSignal) => {
          controller.abort();
          if (signal?.aborted) {
            throw new Error("aborted");
          }
        },
        reconnect: FAST_RECONNECT,
      },
    });

    // Make start fail so we enter backoff.
    const tracker = getSlackAppInstances();
    const origPush = tracker.push.bind(tracker);
    tracker.push = function (...apps) {
      for (const app of apps) {
        app.start.mockRejectedValue(new Error("connection refused"));
      }
      return origPush(...apps);
    };

    const run = monitorSlackProvider(opts);
    await run;

    tracker.push = origPush;
    // Should stop after first failed attempt + abort during sleep.
    // probe + placeholder + 1 reconnect = 3 total
    const instances = getSlackAppInstances();
    expect(instances.length).toBe(3);
  });

  it("HTTP mode has no reconnect loop", async () => {
    const state = getSlackTestState();
    state.config = {
      ...state.config,
      channels: {
        slack: {
          signingSecret: "test-secret",
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
        },
      },
    };
    const { controller, opts } = makeOpts({ mode: "http" });

    const run = monitorSlackProvider(opts);
    await flush();
    controller.abort();
    await run;

    // HTTP mode creates apps but never enters the reconnect loop.
    // Verify no start() was called (HTTP mode doesn't call app.start).
    const instances = getSlackAppInstances();
    for (const app of instances) {
      expect(app.start).not.toHaveBeenCalled();
    }
  });
});
