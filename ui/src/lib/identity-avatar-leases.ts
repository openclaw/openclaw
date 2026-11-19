import {
  readIdentityAvatarGeneration,
  recordAvatarImageError,
  resolveAvatarImageUrl,
  retainAvatarImageUrl,
} from "./identity-avatar-loader.ts";

/** Synchronous view leases; the shared Gateway cache owns image bytes. */
export function createIdentityAvatars() {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let connected = false;
  const routes = new Map<
    string,
    { url: string | null; result: string | Promise<string | null> | null; release?: () => void }
  >();
  let activeRoutes: Set<string> | null = null;
  let generation = readIdentityAvatarGeneration();
  function clearRoutes() {
    for (const route of routes.values()) {
      route.release?.();
    }
    routes.clear();
  }
  function disconnect() {
    connected = false;
    clearRoutes();
  }
  return {
    connect() {
      connected = true;
      notify();
      return disconnect;
    },
    disconnect,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    withActiveRoutes<T>(render: () => T): T {
      activeRoutes = new Set();
      try {
        return render();
      } finally {
        for (const [key, route] of routes) {
          if (!activeRoutes.has(key)) {
            route.release?.();
            routes.delete(key);
          }
        }
        activeRoutes = null;
      }
    },
    imageErrorHandler(value: string): () => void {
      const route = routes.get(value);
      return () => {
        // An old image may fail after its view or Gateway context was replaced.
        if (
          !route?.url ||
          !connected ||
          generation !== readIdentityAvatarGeneration() ||
          routes.get(value) !== route
        ) {
          return;
        }
        recordAvatarImageError(route.result);
        route.url = null;
        notify();
      };
    },
    resolve(value: string): string | null {
      if (!connected) {
        return null;
      }
      if (generation !== readIdentityAvatarGeneration()) {
        clearRoutes();
        generation = readIdentityAvatarGeneration();
      }
      activeRoutes?.add(value);
      const result = value.startsWith("/") ? resolveAvatarImageUrl(value) : value;
      const cached = routes.get(value);
      if (cached && cached.result === result) {
        return cached.url;
      }
      const route: { url: string | null; result: typeof result; release?: () => void } = {
        // Keep the configured source visible until the shared fetch settles.
        url: value,
        result,
        release: retainAvatarImageUrl(result),
      };
      routes.set(value, route);
      const apply = (url: string | null) => {
        if (generation !== readIdentityAvatarGeneration() || routes.get(value) !== route) {
          route.release?.();
          return;
        }
        route.url = url;
      };
      if (typeof result === "string" || result === null) {
        apply(result);
      } else {
        void result.then((url) => {
          apply(url);
          if (connected && routes.get(value) === route) {
            notify();
          }
        });
      }
      cached?.release?.();
      return route.url;
    },
  };
}

export type IdentityAvatars = ReturnType<typeof createIdentityAvatars>;
