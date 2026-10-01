// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

beforeEach(() => {
  stubGatewayStoreTestGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { scopes: [] },
  { scopes: ["operator.sessions.read"] },
  { scopes: ["operator.sessions.write"] },
])(
  "does not renew a canvas capability without operator read access: $scopes",
  async ({ scopes }) => {
    const { gateway, current } = createGatewayStoreTestStore();
    gateway.start();
    current().request.mockRejectedValue(
      new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.read" }),
    );
    const helloUrl = "https://canvas.test/__openclaw__/cap/hello";
    current().opts.onHello?.({
      ...GATEWAY_STORE_TEST_HELLO,
      auth: { role: "operator", scopes },
      pluginSurfaceUrls: { canvas: helloUrl },
    });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(57 * 60_000);

    const refreshes = current().request.mock.calls.filter(
      ([method]) => method === "plugin.surface.refresh",
    );
    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(helloUrl);
    gateway.stop();
    expect(refreshes).toHaveLength(0);
  },
);

it.each(["operator.read", "operator.write", "operator.admin"])(
  "renews with %s and stops after a reconnect without read access",
  async (scope) => {
    const { gateway, current } = createGatewayStoreTestStore();
    gateway.start();
    const helloUrl = "https://canvas.test/__openclaw__/cap/hello";
    const refreshedUrl = "https://canvas.test/__openclaw__/cap/refreshed";
    current().request.mockImplementation(async (method) => {
      if (method === "users.self") {
        return { profile: { id: "reader", emails: [] } };
      }
      return {
        surface: "canvas",
        pluginSurfaceUrls: { canvas: refreshedUrl },
        expiresAtMs: Date.now() + 60_000,
      };
    });
    current().opts.onHello?.({
      ...GATEWAY_STORE_TEST_HELLO,
      auth: { role: "operator", scopes: [scope] },
      pluginSurfaceUrls: { canvas: helloUrl },
    });
    await vi.dynamicImportSettled();
    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(refreshedUrl);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(
      current().request.mock.calls.filter(([method]) => method === "plugin.surface.refresh"),
    ).toHaveLength(2);

    current().opts.onClose?.({ code: 1006, reason: "reconnect", willRetry: true });
    current().request.mockClear();
    current().opts.onHello?.({
      ...GATEWAY_STORE_TEST_HELLO,
      pluginSurfaceUrls: { canvas: helloUrl },
    });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(57 * 60_000);
    const refreshes = current().request.mock.calls.filter(
      ([method]) => method === "plugin.surface.refresh",
    );
    gateway.stop();
    expect(refreshes).toHaveLength(0);
  },
);
