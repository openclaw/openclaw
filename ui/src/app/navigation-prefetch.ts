import { routeIdFromPath, type RouteId } from "../app-route-paths.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";

function canPreload(): boolean {
  // SAFETY: Network Information is optional and is not in TypeScript's DOM library.
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return navigator.onLine && !connection?.saveData && document.visibilityState === "visible";
}

/** Fetch and compile code without evaluating modules or applying route styles. */
export function connectNavigationPrefetch(options: {
  shell: HTMLElement;
  router: Pick<ApplicationContext["router"], "getState" | "subscribe">;
  gateway: Pick<ApplicationContext["gateway"], "snapshot" | "subscribe">;
  outlet: () => Pick<ControlUiReadinessOutlet, "presentationSettled"> | undefined;
  basePath: string;
  resourceBasePath: string;
  transcriptsReady: () => boolean;
  preloadRoute: (routeId: RouteId) => Promise<void>;
}): () => void {
  const descriptor = document
    .getElementById("openclaw-navigation-preloads")
    ?.getAttribute("content");
  const base = new URL(`${options.resourceBasePath.replace(/\/$/u, "")}/`, location.origin);
  const pending = new Set<string>();
  const seen = new Set(performance.getEntriesByType("resource").map((entry) => entry.name));
  const links = new Map<HTMLLinkElement, () => void>();
  const intentTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  const abort = new AbortController();
  let manifest: Record<string, string[]> | undefined = descriptor ? undefined : {};
  let active = true;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let intent: string | undefined;
  // Explicit intent wins. A declared next interaction owns this route's idle work;
  // routes without one fall back to New Session.
  const nextPending = () => {
    if (intent && pending.has(intent)) {
      return intent;
    }
    const currentRoute = options.router.getState().matches[0]?.routeId;
    const currentNext = currentRoute ? `${currentRoute}-next` : undefined;
    if (currentNext && manifest?.[currentNext]) {
      return pending.has(currentNext) ? currentNext : undefined;
    }
    return pending.has("new-session") ? "new-session" : undefined;
  };
  const available = () => {
    const state = options.router.getState();
    return (
      active &&
      canPreload() &&
      options.gateway.snapshot.phase === "connected" &&
      state.status === "success" &&
      state.pendingMatches.length === 0
    );
  };
  const ready = () =>
    available() && options.outlet()?.presentationSettled === true && options.transcriptsReady();
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    if (idle !== undefined) {
      cancelIdleCallback(idle);
      idle = undefined;
    }
  };
  const schedule = () => {
    cancel();
    if (!available() || running || (manifest && !nextPending())) {
      return;
    }
    // Readiness can precede first paint. Leave a quiet window, then ask for idle
    // time without a deadline that could force work into a busy frame.
    timer = setTimeout(() => {
      timer = undefined;
      if (!ready()) {
        schedule();
      } else if ("requestIdleCallback" in window) {
        idle = requestIdleCallback(() => void warm());
      } else {
        void warm();
      }
    }, 500);
  };
  const warm = async () => {
    idle = undefined;
    if (!ready()) {
      schedule();
      return;
    }
    running = true;
    try {
      if (!manifest && descriptor) {
        const response = await fetch(new URL(descriptor, base), {
          signal: abort.signal,
          priority: "low",
        });
        if (!response.ok) {
          manifest = {};
          return;
        }
        // The build owns this hashed descriptor and its same-origin asset paths.
        const entries: Record<string, string[]> = await response.json();
        manifest = entries;
        Object.keys(entries).forEach((key) => pending.add(key));
      }
      if (!ready()) {
        return;
      }
      const currentRoute = options.router.getState().matches[0]?.routeId;
      if (currentRoute) {
        pending.delete(currentRoute);
      }
      const key = nextPending();
      intent = undefined;
      if (!key) {
        return;
      }
      pending.delete(key);
      const loads: Promise<void>[] = [];
      for (const file of manifest?.[key] ?? []) {
        const href = new URL(file, base).href;
        if (seen.has(href)) {
          continue;
        }
        seen.add(href);
        const link = document.createElement("link");
        link.rel = file.endsWith(".css") ? "preload" : "modulepreload";
        if (file.endsWith(".css")) {
          link.as = "style";
        }
        link.crossOrigin = "";
        link.fetchPriority = "low";
        link.href = href;
        loads.push(
          new Promise<void>((resolve) => {
            const finish = () => {
              stopLoad();
              stopError();
              resolve();
            };
            const stopLoad = listen(link, "load", finish, { once: true });
            const stopError = listen(link, "error", finish, { once: true });
            links.set(link, finish);
            document.head.append(link);
          }),
        );
      }
      await Promise.all(loads);
    } catch {
      // Speculation never triggers stale-chunk recovery; navigation owns failures.
      manifest = {};
      pending.clear();
    } finally {
      running = false;
      schedule();
    }
  };
  const prioritize = (key: string) => {
    if (!manifest || pending.has(key)) {
      intent = key;
      if (!running && ready()) {
        cancel();
        void warm();
      }
    }
  };
  const preloadRoute = async (target: Element, routeId: RouteId) => {
    intentTimers.delete(target);
    if (
      !target.isConnected ||
      !target.hasAttribute("href") ||
      target.matches('[aria-current="page"], [aria-disabled="true"]') ||
      !ready() ||
      options.router.getState().matches[0]?.routeId === routeId
    ) {
      return;
    }
    prioritize(routeId === "config" ? "appearance" : routeId);
    try {
      await options.preloadRoute(routeId);
    } catch {
      // Actual navigation owns route-load failures.
    }
  };
  const onIntent = (event: Event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    const routeId = anchor ? routeIdFromPath(anchor.pathname, options.basePath) : null;
    const routeTarget =
      anchor && (routeId === "new-session" || anchor.matches(".nav-item, .settings-sidebar__item"))
        ? anchor
        : null;
    const leaving = event.type === "pointerout" || event.type === "focusout";
    if (routeTarget) {
      const related =
        event instanceof MouseEvent || event instanceof FocusEvent ? event.relatedTarget : null;
      if (related instanceof Node && routeTarget.contains(related)) {
        return;
      }
      if (leaving) {
        clearTimeout(intentTimers.get(routeTarget));
        intentTimers.delete(routeTarget);
        return;
      }
      if (routeId) {
        if (event.type === "touchstart") {
          clearTimeout(intentTimers.get(routeTarget));
          void preloadRoute(routeTarget, routeId);
        } else if (!intentTimers.has(routeTarget)) {
          intentTimers.set(
            routeTarget,
            setTimeout(() => void preloadRoute(routeTarget, routeId), 50),
          );
        }
      }
      return;
    }
    if (leaving) {
      return;
    }
    const key = event.target.closest(
      ".topbar-search, .sidebar-brand__search, .shell-chrome-controls__search",
    )
      ? "palette"
      : event.target.closest(".chat-controls__model-trigger")
        ? "model-picker"
        : event.target.closest('[data-value="command:settings"]')
          ? "appearance"
          : event.target.closest('[data-value="command:debug-overlay"]')
            ? "debug"
            : undefined;
    if (key) {
      prioritize(key);
      if (key === "appearance" && ready()) {
        // The Settings command has no route href; warm its owner's config/schema
        // through the same loader used by ordinary navigation links.
        void options.preloadRoute("appearance").catch(() => undefined);
      }
    }
  };
  const stops = [
    options.router.subscribe(schedule),
    options.gateway.subscribe(schedule),
    listen(options.shell, "pointerover", onIntent),
    listen(options.shell, "pointerout", onIntent),
    listen(options.shell, "focusin", onIntent),
    listen(options.shell, "focusout", onIntent),
    listen(options.shell, "touchstart", onIntent, { passive: true }),
    listen(document, "visibilitychange", schedule),
    listen(window, "online", schedule),
  ];
  schedule();
  return () => {
    active = false;
    cancel();
    abort.abort();
    intentTimers.forEach((intentTimer) => clearTimeout(intentTimer));
    intentTimers.clear();
    stops.forEach((stop) => stop());
    links.forEach((finish, link) => {
      finish();
      link.remove();
    });
  };
}
