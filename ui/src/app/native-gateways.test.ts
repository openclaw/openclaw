/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  embedderSnapshot,
  installEmbedderGatewayTestBridge,
} from "../test-helpers/embedder-gateways.ts";

const EVENT = "openclaw:native-gateways-changed";
const snapshot = {
  gateways: [
    { ...embedderSnapshot.gateways[0], kind: "local" as const },
    { ...embedderSnapshot.gateways[1], id: "profile:studio", name: "Studio" },
  ],
  currentId: "personal",
};
async function nativeCapability() {
  return (await import("./native-gateways.runtime.ts")).nativeGatewaysCapability();
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(window, "addEventListener");
});

afterEach(() => {
  for (const [type, listener] of vi.mocked(window.addEventListener).mock.calls) {
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
  ])("uses a shell's local label with a neutral fallback (%s)", async (name, expected) => {
    installBridge();
    vi.stubGlobal("__OPENCLAW_NATIVE_GATEWAYS__", {
      ...snapshot,
      gateways: [{ ...snapshot.gateways[0], name }],
    });
    const { nativeSetupCapability } = await import("./native-setup.ts");
    const capability = nativeSetupCapability({ nativeDeviceSettings: null, navigate: vi.fn() });

    expect(capability?.currentGateway).toEqual({ name: expected, kind: "local" });
  });

  it("returns null without the WebKit bridge", async () => {
    expect(await nativeCapability()).toBeNull();
  });

  it("initializes from the native global and posts actions", async () => {
    const postMessage = installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    const capability = await nativeCapability();

    expect(capability).not.toBeNull();
    expect(await nativeCapability()).toBe(capability);
    expect(capability?.snapshot).toEqual(snapshot);
    const actions = [
      ["select", "select"],
      ["openWindow", "open-window"],
      ["setPrimary", "set-primary"],
      ["reconnect", "reconnect"],
      ["reconnectCancel", "reconnect-cancel"],
    ] as const;
    for (const [method] of actions) {
      capability?.[method]?.("profile:studio");
    }
    capability?.openSettings();
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      ...actions.map(([, type]) => ({ type, id: "profile:studio" })),
      { type: "open-settings" },
    ]);
  });

  it("updates from events and stops notifying after unsubscribe", async () => {
    installBridge();
    const capability = await nativeCapability();
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
      expect(await nativeCapability()).toBeNull();
      expect(bridge.postMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects foreign sources and malformed envelopes or gateway fields without publishing", async () => {
    const bridge = installEmbedderGatewayTestBridge();
    const nativePost = installBridge();
    Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
    const capability = (await nativeCapability())!;
    expect(capability.snapshot).toBeNull();
    expect(capability.openWindow).toBeUndefined();
    expect(capability.reconnect).toBeUndefined();
    expect(capability.reconnectCancel).toBeUndefined();
    bridge.publish();
    const listener = vi.fn();
    capability.subscribe(listener);
    const data = { type: "openclaw.embedder.gateways", version: 1, snapshot: embedderSnapshot };
    const localGateway = { ...embedderSnapshot.gateways[0], kind: "local" };
    for (const source of [window, null]) {
      window.dispatchEvent(new MessageEvent("message", { source, data }));
    }
    for (const invalid of [
      null,
      { ...data, type: "openclaw.embedder.hello" },
      { ...data, version: 2 },
      { ...data, snapshot: { ...embedderSnapshot, currentId: 3 } },
      { ...data, snapshot: { ...embedderSnapshot, gateways: [{}] } },
      { ...data, snapshot: { ...embedderSnapshot, gateways: [localGateway] } },
    ]) {
      window.dispatchEvent(new MessageEvent("message", { source: bridge.parent, data: invalid }));
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
    expect(capability.snapshot).toEqual(embedderSnapshot);
    expect(listener).not.toHaveBeenCalled();
    expect(nativePost).not.toHaveBeenCalled();
  });
});
