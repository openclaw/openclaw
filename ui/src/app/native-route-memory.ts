import { isRouteId, type RouteId } from "../app-routes.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

// localStorage is per-origin: a remote tunnel recreated on a new ephemeral
// port cannot read routes stored by the old origin and falls back to the
// default route. Accepted — local gateways (the common case) have stable
// origins, and the degraded path matches pre-route-memory behavior.
const NATIVE_LAST_ROUTE_KEY = "openclaw.native.lastRoute";

export type StoredNativeRoute = {
  routeId: RouteId;
  search: string;
};

// The `localStorage` getter itself throws on opaque origins or when
// persistence is blocked, so it must resolve inside a guard, not as a default
// argument evaluated before the function body.
function resolveStorage(storage?: Storage): Storage | null {
  try {
    return storage ?? localStorage;
  } catch {
    return null;
  }
}

export function readStoredRoute(
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): StoredNativeRoute | null {
  const store = nativeHost ? resolveStorage(storage) : null;
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(NATIVE_LAST_ROUTE_KEY);
    if (raw === null) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<StoredNativeRoute>;
    if (
      typeof value.routeId === "string" &&
      isRouteId(value.routeId) &&
      typeof value.search === "string"
    ) {
      return { routeId: value.routeId, search: value.search };
    }
    store.removeItem(NATIVE_LAST_ROUTE_KEY);
  } catch {
    try {
      store.removeItem(NATIVE_LAST_ROUTE_KEY);
    } catch {
      // Storage may be unavailable for this origin; route memory stays optional.
    }
  }
  return null;
}

export function persistRoute(
  routeId: RouteId,
  search: string,
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): void {
  const store = nativeHost ? resolveStorage(storage) : null;
  if (!store) {
    return;
  }
  try {
    store.setItem(NATIVE_LAST_ROUTE_KEY, JSON.stringify({ routeId, search }));
  } catch {
    // Storage may be unavailable for this origin; navigation must still work.
  }
}

export function shouldRestore(
  routeId: RouteId,
  search: string,
  nativeHost = isNativeWebChromeHost(),
): boolean {
  return nativeHost && routeId === "chat" && search === "";
}
