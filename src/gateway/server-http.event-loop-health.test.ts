import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readHttp } from "./control-ui-fixture.test-support.js";
import { listenProvider } from "./gateway-provider-fixture.test-support.js";
import { AUTH_NONE, withGatewayServer } from "./server-http.test-harness.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";

const nativeDelay = vi.hoisted(() => ({ max: 20_000_000 }));
vi.mock("node:perf_hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:perf_hooks")>()),
  monitorEventLoopDelay: () => ({
    get max() {
      return nativeDelay.max;
    },
    percentile: () => nativeDelay.max,
    reset: () => {
      nativeDelay.max = 20_000_000;
    },
    enable: () => true,
    disable: () => true,
  }),
}));

afterEach(() => vi.restoreAllMocks());

async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await readHttp(url);
  expect(response.status).toBe(200);
  return JSON.parse(response.text);
}

it("retains a blocked request interval when readiness is read before the sampler resumes", async () => {
  const clock = createGatewaySchedulerClock();
  vi.spyOn(performance, "now").mockImplementation(clock.clock.now);
  const monitor = createGatewayEventLoopHealthMonitor({
    scheduler: createTestGatewayScheduler(clock.clock),
  });
  let blockNextRead = false;
  try {
    await withGatewayServer({
      prefix: "event-loop-http-owner",
      resolvedAuth: AUTH_NONE,
      overrides: {
        getReadiness: () => {
          if (blockNextRead) {
            blockNextRead = false;
            nativeDelay.max = 1_200_000_000;
            clock.setTime(clock.clock.now() + 1_200);
            const beforePendingSample = monitor.snapshot();
            for (let index = 0; index < 100; index++) {
              expect(monitor.snapshot()).toBe(beforePendingSample);
            }
          }
          return {
            ready: true,
            failing: [],
            uptimeMs: clock.clock.now(),
            eventLoop: monitor.snapshot(),
          };
        },
      },
      run: async (server) => {
        const url = new URL("/readyz", await listenProvider(server)).href;
        try {
          for (let index = 0; index < 50; index++) {
            await clock.advanceBy(20);
          }
          expect((await readJson(url)).ready).toBe(true);
          blockNextRead = true;
          await readJson(url);
          await clock.wake();
          expect(await readJson(url)).toMatchObject({
            ready: true,
            eventLoop: {
              degraded: true,
              reasons: expect.arrayContaining(["event_loop_delay"]),
              delayMaxMs: expect.toSatisfy((ms: unknown) => typeof ms === "number" && ms >= 1_000),
            },
          });
        } finally {
          server.closeAllConnections();
          await server[Symbol.asyncDispose]();
        }
      },
    });
  } finally {
    monitor.stop();
  }
  expect(monitor.snapshot()).toBeUndefined();
});
