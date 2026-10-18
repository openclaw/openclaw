// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import type { GatewayHelloOk } from "../api/gateway.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { isHomePanelAvailable } from "./panel-availability.ts";

describe("Gateway presentation retention", () => {
  let store: ReturnType<typeof createGatewayStoreTestStore>;
  const hello = (): GatewayHelloOk => ({
    ...GATEWAY_STORE_TEST_HELLO,
    auth: { role: "operator", scopes: ["operator.admin"] },
    features: { methods: ["plugins.reload", "chat.history", "chat.send"] },
    controlUiTabs: [{ pluginId: "notes", id: "notes", label: "Notes" }],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    stubGatewayStoreTestGlobals();
    store = createGatewayStoreTestStore();
    store.gateway.start();
    store.current().opts.onHello?.(hello());
  });

  afterEach(() => {
    store.gateway.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([true, false])("retains display facts on transport close (willRetry=%s)", (willRetry) => {
    const accepted = store.gateway.snapshot.hello;
    const capabilities = store.gateway.snapshot.pluginCapabilities;
    expect(capabilities).not.toBeNull();
    store.current().opts.onClose?.({ code: 1006, reason: "network lost", willRetry });
    expect(store.gateway.snapshot.phase).toBe(willRetry ? "reconnecting" : "offline");
    expect(store.gateway.snapshot.hello).toBe(accepted);
    expect(store.gateway.snapshot.pluginCapabilities).toBe(capabilities);
    expect(isHomePanelAvailable(store.gateway)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(store.gateway.snapshot.offlineStable).toBe(true);
    expect(store.gateway.snapshot.hello).toBe(accepted);
    expect(store.gateway.snapshot.pluginCapabilities).toBe(capabilities);

    const replacement = hello();
    replacement.features = { methods: ["plugin.notes.read"] };
    replacement.controlUiTabs = [];
    store.current().opts.onHello?.(replacement);
    expect(store.gateway.snapshot.phase).toBe("connected");
    expect(store.gateway.snapshot.hello).toBe(replacement);
    expect(store.gateway.snapshot.pluginCapabilities?.methods).toEqual(["plugin.notes.read"]);
    expect(store.gateway.snapshot.hello?.controlUiTabs).toEqual([]);
  });

  it.each([
    { name: "pairing rejection", code: "PAIRING_REQUIRED" },
    {
      name: "auth rejection",
      code: "INVALID_REQUEST",
      details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
    },
    {
      name: "protocol rejection",
      code: "INVALID_REQUEST",
      details: { code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH },
    },
    {
      name: "build mismatch",
      code: "UNAVAILABLE",
      details: {
        code: ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
    },
  ])("clears display facts on $name", ({ code, details }) => {
    store.current().opts.onClose?.({
      code: 1008,
      reason: "admission rejected",
      willRetry: false,
      error: { code, message: "admission rejected", details },
    });
    expect(store.gateway.snapshot.hello).toBeNull();
    expect(store.gateway.snapshot.pluginCapabilities).toBeNull();
    expect(isHomePanelAvailable(store.gateway)).toBe(false);
  });

  it.each([
    { name: "stop", change: () => store.gateway.stop() },
    {
      name: "token change",
      change: () => store.gateway.connect({ token: "synthetic-replacement" }),
    },
    {
      name: "password change",
      change: () => store.gateway.connect({ password: "synthetic-password" }),
    },
    {
      name: "bootstrap change",
      change: () => store.gateway.connect({ bootstrapToken: "synthetic-bootstrap" }),
    },
    {
      name: "Gateway change",
      change: () => store.gateway.connect({ gatewayUrl: "wss://other.example.test" }),
    },
    { name: "client replacement", change: () => store.gateway.connect() },
  ])("clears display facts on $name", ({ change }) => {
    change();
    expect(store.gateway.snapshot.hello).toBeNull();
    expect(store.gateway.snapshot.pluginCapabilities).toBeNull();
    expect(isHomePanelAvailable(store.gateway)).toBe(false);
  });
});
