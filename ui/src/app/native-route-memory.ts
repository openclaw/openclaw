import { isRouteId, type RouteId } from "../app-routes.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

// localStorage is per-origin: a remote tunnel recreated on a new ephemeral
// port cannot read routes stored by the old origin and falls back to the
// default route. Accepted — local gateways (the common case) have stable
// origins, and the degraded path matches pre-route-memory behavior.
const NATIVE_LAST_ROUTE_KEY = "openclaw.native.lastRoute";

type StoredNativeRoute = {
  routeId: RouteId;
  pathname: string;
  search: string;
};

function readStoredRoute(
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): StoredNativeRoute | null {
  const store = nativeHost ? (storage ?? getSafeLocalStorage()) : null;
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
      typeof value.pathname === "string" &&
      typeof value.search === "string"
    ) {
      return { routeId: value.routeId, pathname: value.pathname, search: value.search };
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

// One-shot action params (palette slash-command drafts) must not replay on a
// later launch; the pathname now owns session identity.
function restorableSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("draft");
  const filtered = params.toString();
  return filtered ? `?${filtered}` : "";
}

export function persistRoute(
  routeId: RouteId,
  pathname: string,
  search: string,
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): void {
  const store = nativeHost ? (storage ?? getSafeLocalStorage()) : null;
  if (!store) {
    return;
  }
  try {
    store.setItem(
      NATIVE_LAST_ROUTE_KEY,
      JSON.stringify({ routeId, pathname, search: restorableSearch(search) }),
    );
  } catch {
    // Storage may be unavailable for this origin; navigation must still work.
  }
}

/**
 * Returns the stored route to restore, or null when the boot route is an
 * explicit deep link, matches the stored route, or no valid entry exists.
 */
export function considerRouteRestore(
  routeId: RouteId,
  pathname: string,
  search: string,
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): StoredNativeRoute | null {
  if (!nativeHost || routeId !== "chat" || !pathname.endsWith("/chat") || search !== "") {
    return null;
  }
  const stored = readStoredRoute(storage, nativeHost);
  if (
    !stored ||
    (stored.routeId === routeId && stored.pathname === pathname && stored.search === search)
  ) {
    return null;
  }
  return stored;
}
