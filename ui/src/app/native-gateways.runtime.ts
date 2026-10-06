import { registerListener } from "../../../src/shared/listeners.js";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

export type NativeGateway = {
  id: string;
  name: string;
  kind: "local" | "remote";
  isPrimary: boolean;
  canPromote: boolean;
  health: "ok" | "error" | "unknown";
};

export type NativeGatewaysSnapshot = { gateways: NativeGateway[]; currentId: string };
type NativeGatewaysWindow = Window & {
  __OPENCLAW_NATIVE_GATEWAYS__?: unknown;
};

const NATIVE_GATEWAYS_CHANGED_EVENT = "openclaw:native-gateways-changed";

export type NativeGatewaysCapability = NonNullable<
  ReturnType<typeof createNativeGatewaysCapability>
>;

function snapshotFrom(value: unknown): NativeGatewaysSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as Partial<NativeGatewaysSnapshot>;
  // The embedder owns this payload; deep validation only defends the Mac app from itself.
  return Array.isArray(snapshot.gateways) && typeof snapshot.currentId === "string"
    ? (snapshot as NativeGatewaysSnapshot)
    : null;
}

function createNativeGatewaysCapability() {
  if (typeof window === "undefined") {
    return null;
  }
  const nativeWindow = window as NativeGatewaysWindow;
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawGateways;
  if (!handler?.postMessage) {
    return null;
  }
  const post = handler.postMessage.bind(handler);
  let snapshot = snapshotFrom(nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"]);
  const listeners = new Set<(snapshot: NativeGatewaysSnapshot) => void>();
  const onChange = (event: Event) => {
    const next = snapshotFrom((event as CustomEvent<unknown>).detail);
    if (!next) {
      return;
    }
    snapshot = next;
    listeners.forEach((listener) => listener(next));
  };
  window.addEventListener(NATIVE_GATEWAYS_CHANGED_EVENT, onChange);
  return {
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener: (snapshot: NativeGatewaysSnapshot) => void) =>
      registerListener(listeners, listener),
    select: (id: string) => post({ type: "select", id }),
    openWindow: (id: string) => post({ type: "open-window", id }),
    setPrimary: (id: string) => post({ type: "set-primary", id }),
    reconnect: (id: string) => post({ type: "reconnect", id }),
    reconnectCancel: (id: string) => post({ type: "reconnect-cancel", id }),
    openSettings: () => post({ type: "open-settings" }),
  };
}

let singleton: NativeGatewaysCapability | null | undefined;

// Loaded by native chat features and sidebar menus, outside the startup bundle.
export function nativeGatewaysCapability(): NativeGatewaysCapability | null {
  if (singleton === undefined) {
    singleton = createNativeGatewaysCapability();
  }
  return singleton;
}
