/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";
import { startNativeGatewayHealthReporting } from "./native-gateway-health.runtime.ts";

const HEALTH = "__OPENCLAW_NATIVE_GATEWAY_HEALTH__";
const EVENT = "openclaw:native-gateway-health-changed";
const cleanups: (() => void)[] = [];

afterEach(async () => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup());
  await vi.dynamicImportSettled();
  Reflect.deleteProperty(window, HEALTH);
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function connectedStore() {
  const store = createGatewayStoreTestStore();
  cleanups.push(() => store.gateway.stop());
  store.gateway.start();
  store.current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  return store;
}

describe("native dashboard connection health", () => {
  it.each([false, true])(
    "reports failure until recovery or intentional stop (admitted=%s)",
    (admitted) => {
      const { gateway, current } = createGatewayStoreTestStore();
      cleanups.push(() => gateway.stop());
      gateway.start();
      if (admitted) {
        current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
      }
      const events = vi.fn();
      window.addEventListener(EVENT, events);
      cleanups.push(() => window.removeEventListener(EVENT, events));
      const stop = startNativeGatewayHealthReporting(gateway);
      cleanups.push(stop);
      const gatewayUrl = gateway.connection.gatewayUrl;
      if (admitted) {
        expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "ok" });
        expect(events).toHaveBeenCalledOnce();
        gateway.setSessionKey("agent:main:another");
        expect(events).toHaveBeenCalledOnce();
      }
      current().opts.onClose?.(
        admitted
          ? { code: 1006, reason: "socket lost", willRetry: true }
          : { code: 4008, reason: "connect failed", willRetry: false },
      );
      expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "error" });
      if (admitted) {
        current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
        expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "ok" });
      } else {
        expect(gateway.snapshot.phase).toBe("stopped");
        expect(gateway.snapshot.lastError).toContain("4008");
      }
      gateway.stop();
      expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "unknown" });
      stop();
      events.mockClear();
      gateway.start();
      current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
      expect(events).not.toHaveBeenCalled();
      expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "unknown" });
    },
  );

  it("reports endpoint changes and cannot be overwritten by an older reporter or client", () => {
    const first = connectedStore();
    const stopFirst = startNativeGatewayHealthReporting(first.gateway);
    cleanups.push(stopFirst);
    const second = connectedStore();
    const stopSecond = startNativeGatewayHealthReporting(second.gateway);
    cleanups.push(stopSecond);
    const oldClient = second.current();
    const gatewayUrl = "wss://other.example/control";
    second.gateway.connect({ gatewayUrl });
    expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "unknown" });
    second.current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
    oldClient.opts.onClose?.({ code: 1006, reason: "old socket", willRetry: false });
    first.gateway.stop();
    stopFirst();
    expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "ok" });
    stopSecond();
    stopFirst();
    expect(Reflect.get(window, HEALTH)).toEqual({ gatewayUrl, health: "unknown" });
  });
});
