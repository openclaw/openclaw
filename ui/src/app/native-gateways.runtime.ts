import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { registerListener } from "../../../src/shared/listeners.js";
import { webKitHostWindow, type WebKitHostMessages } from "./native-webkit-bridge.ts";
import { isRemoteControlUiIngress } from "./remote-ingress.ts";

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

export type NativeGatewaysCapability = {
  readonly snapshot: NativeGatewaysSnapshot | null;
  subscribe: (listener: (snapshot: NativeGatewaysSnapshot) => void) => () => void;
  select: (id: string) => void;
  setPrimary: (id: string) => void;
  openSettings: () => void;
  openWindow?: (id: string) => void;
  reconnect?: (id: string) => void;
  reconnectCancel?: (id: string) => void;
};

function snapshotFrom(value: unknown): NativeGatewaysSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as Partial<NativeGatewaysSnapshot>;
  // The native app owns this payload; postMessage snapshots are validated separately.
  return Array.isArray(snapshot.gateways) && typeof snapshot.currentId === "string"
    ? (snapshot as NativeGatewaysSnapshot)
    : null;
}

function embedderSnapshotFrom(value: unknown): NativeGatewaysSnapshot | null {
  if (
    !isRecord(value) ||
    value.type !== "openclaw.embedder.gateways" ||
    value.version !== 1 ||
    !isRecord(value.snapshot)
  ) {
    return null;
  }
  const snapshot = snapshotFrom(value.snapshot);
  return snapshot?.gateways.every(
    (gateway: unknown): gateway is NativeGateway =>
      isRecord(gateway) &&
      typeof gateway.id === "string" &&
      typeof gateway.name === "string" &&
      gateway.kind === "remote" &&
      typeof gateway.isPrimary === "boolean" &&
      typeof gateway.canPromote === "boolean" &&
      (gateway.health === "ok" || gateway.health === "error" || gateway.health === "unknown"),
  )
    ? { gateways: snapshot.gateways, currentId: snapshot.currentId }
    : null;
}

function createNativeGatewaysCapability(): NativeGatewaysCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  const nativeWindow = window as NativeGatewaysWindow;
  const parent = window.parent;
  const embedded = isRemoteControlUiIngress() && parent !== window;
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawGateways;
  const post = embedded
    ? (message: WebKitHostMessages["openclawGateways"]) =>
        parent.postMessage({ ...message, type: `openclaw.embedder.${message.type}` }, "*")
    : handler?.postMessage.bind(handler);
  if (!post) {
    return null;
  }
  let snapshot = embedded ? null : snapshotFrom(nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"]);
  const listeners = new Set<(snapshot: NativeGatewaysSnapshot) => void>();
  window.addEventListener(embedded ? "message" : NATIVE_GATEWAYS_CHANGED_EVENT, (event: Event) => {
    let next: NativeGatewaysSnapshot | null;
    if (embedded) {
      // SAFETY: The selected event name matches the embedded transport.
      const message = event as MessageEvent<unknown>;
      if (message.source !== parent) {
        return;
      }
      next = embedderSnapshotFrom(message.data);
    } else {
      next = snapshotFrom((event as CustomEvent<unknown>).detail);
    }
    if (!next) {
      return;
    }
    snapshot = next;
    if (embedded) {
      nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"] = next;
    }
    listeners.forEach((listener) => listener(next));
    if (embedded) {
      // Keep the existing display-only sidebar projection and its wake-up event.
      window.dispatchEvent(new CustomEvent(NATIVE_GATEWAYS_CHANGED_EVENT, { detail: next }));
    }
  });
  if (embedded) {
    parent.postMessage({ type: "openclaw.embedder.hello", version: 1 }, "*");
  }
  return {
    select: (id) => post({ type: "select", id }),
    setPrimary: (id) => post({ type: "set-primary", id }),
    openSettings: () => post({ type: "open-settings" }),
    ...(!embedded && {
      openWindow: (id: string) => post({ type: "open-window", id }),
      reconnect: (id: string) => post({ type: "reconnect", id }),
      reconnectCancel: (id: string) => post({ type: "reconnect-cancel", id }),
    }),
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener) => registerListener(listeners, listener),
  };
}

let singleton: NativeGatewaysCapability | null | undefined;

// Loaded by native chat features, sidebar menus, and remote-ingress startup.
export function nativeGatewaysCapability(): NativeGatewaysCapability | null {
  if (singleton === undefined) {
    singleton = createNativeGatewaysCapability();
  }
  return singleton;
}
