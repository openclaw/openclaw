import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { markPluginHttpLegacyListener } from "../plugins/http-legacy-listener.js";
import {
  getLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createAuthRateLimiter, resolveRequestClientIp } from "./webhook-ingress.js";

function request(): IncomingMessage {
  return {
    headers: { "x-forwarded-for": "192.0.2.99" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("resolveRequestClientIp", () => {
  it.each([false, true])("uses the listener's proxy attribution policy (legacy=%s)", (legacy) => {
    const req = request();
    if (legacy) {
      markPluginHttpLegacyListener(req, { port: 8788 });
    }
    const clientIp = withPluginRuntimeGatewayRequestScope(
      {
        client: { clientIp: "198.51.100.42" } as never,
        isWebchatConnect: () => false,
      },
      () => resolveRequestClientIp(req, ["127.0.0.1"]),
    );

    expect(clientIp).toBe(legacy ? "192.0.2.99" : "198.51.100.42");
  });

  it("retains configured-proxy resolution outside Gateway request scope", () => {
    expect(resolveRequestClientIp(request(), ["127.0.0.1"])).toBe("192.0.2.99");
  });
});

it("prunes SDK limiters on their Gateway's clock without sharing their lifecycle", async () => {
  const firstClock = createGatewaySchedulerClock(1_000);
  const secondClock = createGatewaySchedulerClock(10_000);
  const firstScheduler = createTestGatewayScheduler(firstClock.clock);
  const secondScheduler = createTestGatewayScheduler(secondClock.clock);
  const firstHost = new LegacyPluginSdkResourceHost();
  const secondHost = new LegacyPluginSdkResourceHost();
  const unboundHost = new LegacyPluginSdkResourceHost();
  firstHost.bindScheduler(firstScheduler);
  secondHost.bindScheduler(secondScheduler);
  const config = { windowMs: 100, pruneIntervalMs: 100 };
  const first = firstHost.run(() => createAuthRateLimiter(config));
  const peer = firstHost.run(() => createAuthRateLimiter(config));
  const second = secondHost.run(() => createAuthRateLimiter(config));
  try {
    for (const limiter of [first, peer, second]) {
      limiter.recordFailure("192.0.2.1");
    }
    await firstClock.advanceBy(100);
    expect([first.size(), peer.size(), second.size()]).toEqual([0, 0, 1]);
    first.dispose();
    peer.recordFailure("192.0.2.1");
    await firstClock.advanceBy(100);
    expect(peer.size()).toBe(0);
    await firstScheduler.stop();
    await firstHost.close();
    await secondClock.advanceBy(100);
    expect(second.size()).toBe(0);
    expect(() => firstHost.run(() => createAuthRateLimiter(config))).toThrow(
      "Plugin SDK resource host is closed",
    );
    expect(() => unboundHost.run(() => createAuthRateLimiter(config))).toThrow(
      "Plugin SDK resource host has no Gateway scheduler",
    );
    const standalone = createAuthRateLimiter({ pruneIntervalMs: 0 });
    standalone.recordFailure("192.0.2.1");
    expect(standalone.size()).toBe(1);
    standalone.dispose();
    const retainedStandalone = getLegacyPluginSdkResourceHost().run(() =>
      createAuthRateLimiter({ pruneIntervalMs: 0 }),
    );
    retainedStandalone.recordFailure("192.0.2.1");
    expect(retainedStandalone.size()).toBe(1);
    retainedStandalone.dispose();
  } finally {
    first.dispose();
    peer.dispose();
    second.dispose();
    await Promise.all([
      firstScheduler.stop(),
      secondScheduler.stop(),
      firstHost.close(),
      secondHost.close(),
      unboundHost.close(),
    ]);
  }
});
