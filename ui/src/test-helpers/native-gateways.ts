import { vi } from "vitest";
import * as nativeGateways from "../app/native-gateways.runtime.ts";
import type { NativeGateway, NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";

export function setNativeGatewayTestState(kind: NativeGateway["kind"] | null) {
  if (!kind) {
    Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
    Reflect.deleteProperty(window, "webkit");
    vi.spyOn(nativeGateways, "nativeGatewaysCapability").mockReturnValue(null);
    return undefined;
  }
  const snapshot: NativeGatewaysSnapshot = {
    gateways: [
      {
        id: "local",
        name: "Local Gateway",
        kind: "local",
        isPrimary: true,
        canPromote: false,
        health: "ok",
      },
      {
        id: "remote",
        name: "Remote Gateway",
        kind: "remote",
        isPrimary: false,
        canPromote: true,
        health: "ok",
      },
    ],
    currentId: kind,
  };
  const postMessage = vi.fn();
  Object.assign(window, {
    __OPENCLAW_NATIVE_GATEWAYS__: snapshot,
    webkit: { messageHandlers: { openclawGateways: { postMessage } } },
  });
  window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", { detail: snapshot }));
  return postMessage;
}

export function clearNativeGatewayTestState(): void {
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
  Reflect.deleteProperty(window, "webkit");
}
