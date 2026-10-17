/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  embedderSnapshot,
  installEmbedderGatewayTestBridge,
} from "../test-helpers/embedder-gateways.ts";

const EVENT = "openclaw:native-gateways-changed";
const snapshot = {
  gateways: [
    {
      id: "primary",
      name: "Local Gateway",
      kind: "local" as const,
      isPrimary: true,
      canPromote: false,
      health: "ok" as const,
    },
    {
      id: "profile:studio",
      name: "Studio",
      kind: "remote" as const,
      isPrimary: false,
      canPromote: true,
      health: "unknown" as const,
    },
  ],
  currentId: "primary",
};

let windowListeners: Array<[string, EventListenerOrEventListenerObject]>;

beforeEach(() => {
  vi.resetModules();
  windowListeners = [];
  const addEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    windowListeners.push([type, listener]);
    addEventListener(type, listener, options);
  });
});

afterEach(() => {
  for (const [type, listener] of windowListeners) {
    window.removeEventListener(type, listener);
  }
  document.documentElement.removeAttribute("data-openclaw-remote-ingress");
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "webkit");
});

function installBridge() {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawGateways: { postMessage } } });
  return postMessage;
}

describe("native gateways", () => {
  it.each([
    ["", "This computer"],
    ["This Mac", "This Mac"],
    ["My desktop", "My desktop"],
  ])("uses a shell's local label with a neutral fallback (%s)", async (name, expected) => {
    installBridge();
    Object.assign(window, {
      __OPENCLAW_NATIVE_GATEWAYS__: {
        ...snapshot,
        gateways: [{ ...snapshot.gateways[0], name }],
      },
    });
    const { nativeSetupCapability } = await import("./native-setup.ts");
    const capability = nativeSetupCapability({ nativeDeviceSettings: null, navigate: vi.fn() });

    expect(capability?.currentGateway).toEqual({ name: expected, kind: "local" });
  });

  it("returns null without the WebKit bridge", async () => {
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");

    expect(nativeGatewaysCapability()).toBeNull();
  });

  it("initializes from the native global and posts actions", async () => {
    const postMessage = installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
    const capability = nativeGatewaysCapability();

    expect(capability?.snapshot).toEqual(snapshot);
    capability?.select("profile:studio");
    capability?.openWindow?.("profile:studio");
    capability?.setPrimary("profile:studio");
    capability?.reconnect?.("profile:studio");
    capability?.reconnectCancel?.("profile:studio");
    capability?.openSettings();
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "select", id: "profile:studio" },
      { type: "open-window", id: "profile:studio" },
      { type: "set-primary", id: "profile:studio" },
      { type: "reconnect", id: "profile:studio" },
      { type: "reconnect-cancel", id: "profile:studio" },
      { type: "open-settings" },
    ]);
  });

  it("updates from events and stops notifying after unsubscribe", async () => {
    installBridge();
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
    const capability = nativeGatewaysCapability();
    const listener = vi.fn();
    const unsubscribe = capability?.subscribe(listener);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    expect(capability?.snapshot).toEqual(snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot);
    unsubscribe?.();
    listener.mockClear();
    window.dispatchEvent(
      new CustomEvent(EVENT, { detail: { ...snapshot, currentId: "profile:studio" } }),
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("creates the app-lifetime singleton only once", async () => {
    installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");

    const first = nativeGatewaysCapability();
    const second = nativeGatewaysCapability();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});

describe("embedder gateways", () => {
  it.each(["unmarked frame", "top-level remote ingress"])(
    "does not enable the transport in a %s",
    async (context) => {
      const bridge = installEmbedderGatewayTestBridge();
      if (context === "unmarked frame") {
        document.documentElement.removeAttribute("data-openclaw-remote-ingress");
      } else {
        vi.stubGlobal("parent", window);
      }
      const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
      expect(nativeGatewaysCapability()).toBeNull();
      expect(bridge.postMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects foreign sources and malformed envelopes or gateway fields without publishing", async () => {
    const bridge = installEmbedderGatewayTestBridge();
    const nativePost = installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
    const capability = nativeGatewaysCapability()!;
    expect(capability.snapshot).toBeNull();
    expect(capability.openWindow).toBeUndefined();
    expect(capability.reconnect).toBeUndefined();
    expect(capability.reconnectCancel).toBeUndefined();
    bridge.publish();
    const listener = vi.fn();
    capability.subscribe(listener);
    const data = { type: "openclaw.embedder.gateways", version: 1, snapshot: embedderSnapshot };
    for (const source of [window, null]) {
      window.dispatchEvent(new MessageEvent("message", { source, data }));
    }
    for (const invalid of [
      null,
      { ...data, type: "openclaw.embedder.hello" },
      { ...data, version: 2 },
      { ...data, snapshot: { ...embedderSnapshot, currentId: 3 } },
      { ...data, snapshot: { ...embedderSnapshot, gateways: [{}] } },
      {
        ...data,
        snapshot: {
          ...embedderSnapshot,
          gateways: [{ ...embedderSnapshot.gateways[0], kind: "local" }],
        },
      },
    ]) {
      window.dispatchEvent(new MessageEvent("message", { source: bridge.parent, data: invalid }));
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    expect(capability.snapshot).toEqual(embedderSnapshot);
    expect(listener).not.toHaveBeenCalled();
    expect(nativePost).not.toHaveBeenCalled();
  });
});
