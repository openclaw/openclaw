import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { markPluginHttpLegacyListener } from "../plugins/http-legacy-listener.js";
import * as resources from "../plugins/legacy-sdk-resource-host.js";
import { withPluginRuntimeGatewayRequestScope as withScope } from "../plugins/runtime/gateway-request-scope.js";
import * as clocks from "../test-utils/gateway-scheduler-clock.js";
import { createAuthRateLimiter, resolveRequestClientIp } from "./webhook-ingress.js";

it.each([
  [false, "198.51.100.42"],
  [true, "192.0.2.99"],
  [undefined, "192.0.2.99"],
])("uses proxy attribution (legacy=%s, undefined=unscoped)", (legacy, expected) => {
  const req = {
    headers: { "x-forwarded-for": "192.0.2.99" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
  if (legacy) {
    markPluginHttpLegacyListener(req, { port: 8788 });
  }
  const resolve = () => resolveRequestClientIp(req, ["127.0.0.1"]);
  const scope = {
    client: { clientIp: "198.51.100.42" } as never,
    isWebchatConnect: () => false,
  };
  expect(legacy === undefined ? resolve() : withScope(scope, resolve)).toBe(expected);
});

function scheduledHost(now: number) {
  const clock = clocks.createGatewaySchedulerClock(now);
  const scheduler = clocks.createTestGatewayScheduler(clock.clock);
  const host = new resources.LegacyPluginSdkResourceHost();
  host.bindScheduler(scheduler);
  const close = () => Promise.all([scheduler.stop(), host.close()]);
  return { clock, scheduler, host, close };
}

it("prunes SDK limiters on their Gateway's clock without sharing their lifecycle", async () => {
  const a = scheduledHost(1_000);
  const b = scheduledHost(10_000);
  const unbound = new resources.LegacyPluginSdkResourceHost();
  const create = () => createAuthRateLimiter({ windowMs: 100, pruneIntervalMs: 100 });
  const first = a.host.run(create);
  const peer = a.host.run(create);
  const second = b.host.run(create);
  const limiters = [first, peer, second];
  try {
    limiters.forEach((limiter) => limiter.recordFailure("192.0.2.1"));
    await a.clock.advanceBy(100);
    expect(limiters.map((limiter) => limiter.size())).toEqual([0, 0, 1]);
    first.dispose();
    peer.recordFailure("192.0.2.1");
    await a.clock.advanceBy(100);
    expect(peer.size()).toBe(0);
    await a.scheduler.stop();
    await a.host.close();
    await b.clock.advanceBy(100);
    expect(second.size()).toBe(0);
    expect(() => a.host.run(create)).toThrow("Plugin SDK resource host is closed");
    expect(() => unbound.run(create)).toThrow("Plugin SDK resource host has no Gateway scheduler");
    const standalone = () => createAuthRateLimiter({ pruneIntervalMs: 0 });
    for (const factory of [
      standalone,
      () => resources.getLegacyPluginSdkResourceHost().run(standalone),
    ]) {
      const limiter = factory();
      limiter.recordFailure("192.0.2.1");
      expect(limiter.size()).toBe(1);
      limiter.dispose();
    }
  } finally {
    limiters.forEach((limiter) => limiter.dispose());
    await Promise.all([a.close(), b.close(), unbound.close()]);
  }
});
