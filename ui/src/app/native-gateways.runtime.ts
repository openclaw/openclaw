import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { registerListener } from "../../../src/shared/listeners.js";
import { webKitHostWindow } from "./native-webkit-bridge.ts";
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
  const { gateways, currentId } = value.snapshot;
  if (
    typeof currentId !== "string" ||
    !Array.isArray(gateways) ||
    !gateways.every(
      (gateway: unknown): gateway is NativeGateway =>
        isRecord(gateway) &&
        typeof gateway.id === "string" &&
        typeof gateway.name === "string" &&
        gateway.kind === "remote" &&
        typeof gateway.isPrimary === "boolean" &&
        typeof gateway.canPromote === "boolean" &&
        (gateway.health === "ok" || gateway.health === "error" || gateway.health === "unknown"),
    )
  ) {
    return null;
  }
  return { gateways, currentId };
}

function createNativeGatewaysCapability(): NativeGatewaysCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  const nativeWindow = window as NativeGatewaysWindow;
  const embedded = isRemoteControlUiIngress() && window.parent !== window;
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawGateways;
  let snapshot = embedded ? null : snapshotFrom(nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"]);
  const listeners = new Set<(snapshot: NativeGatewaysSnapshot) => void>();
  const publish = (next: NativeGatewaysSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener(next));
  };
  let actions: Omit<NativeGatewaysCapability, "snapshot" | "subscribe">;
  if (embedded) {
    const parent = window.parent;
    const post = (
      message:
        | { type: "openclaw.embedder.hello"; version: 1 }
        | { type: "openclaw.embedder.select" | "openclaw.embedder.set-primary"; id: string }
        | { type: "openclaw.embedder.open-settings" },
    ) => parent.postMessage(message, "*");
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.source !== parent) {
        return;
      }
      const next = embedderSnapshotFrom(event.data);
      if (!next) {
        return;
      }
      // Keep the existing display-only sidebar projection and its wake-up event.
      nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"] = next;
      publish(next);
      window.dispatchEvent(new CustomEvent(NATIVE_GATEWAYS_CHANGED_EVENT, { detail: next }));
    });
    post({ type: "openclaw.embedder.hello", version: 1 });
    actions = {
      select: (id) => post({ type: "openclaw.embedder.select", id }),
      setPrimary: (id) => post({ type: "openclaw.embedder.set-primary", id }),
      openSettings: () => post({ type: "openclaw.embedder.open-settings" }),
    };
  } else if (handler?.postMessage) {
    const post = handler.postMessage.bind(handler);
    window.addEventListener(NATIVE_GATEWAYS_CHANGED_EVENT, (event: Event) => {
      const next = snapshotFrom((event as CustomEvent<unknown>).detail);
      if (next) {
        publish(next);
      }
    });
    actions = {
      select: (id: string) => post({ type: "select", id }),
      openWindow: (id: string) => post({ type: "open-window", id }),
      setPrimary: (id: string) => post({ type: "set-primary", id }),
      reconnect: (id: string) => post({ type: "reconnect", id }),
      reconnectCancel: (id: string) => post({ type: "reconnect-cancel", id }),
      openSettings: () => post({ type: "open-settings" }),
    };
  } else {
    return null;
  }
  return {
    ...actions,
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
