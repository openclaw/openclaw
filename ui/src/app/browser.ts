import type { RouteLocation, RouterHistory } from "../router/types.ts";

function readLocation(): RouteLocation {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

function writeLocation(location: RouteLocation) {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function createBrowserHistory(): RouterHistory {
  const listeners = new Set<(location: RouteLocation) => void>();
  let stopPopState: (() => void) | undefined;

  const ensurePopStateListener = () => {
    if (stopPopState) {
      return;
    }
    const onPopState = () => {
      const location = readLocation();
      for (const listener of listeners) {
        listener(location);
      }
    };
    window.addEventListener("popstate", onPopState);
    stopPopState = () => window.removeEventListener("popstate", onPopState);
  };

  const releasePopStateListener = () => {
    if (listeners.size === 0) {
      stopPopState?.();
      stopPopState = undefined;
    }
  };

  return {
    location: readLocation,
    push: (location) => window.history.pushState({}, "", writeLocation(location)),
    replace: (location) => window.history.replaceState({}, "", writeLocation(location)),
    listen: (listener) => {
      listeners.add(listener);
      ensurePopStateListener();
      return () => {
        listeners.delete(listener);
        releasePopStateListener();
      };
    },
  };
}
