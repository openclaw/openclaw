import { routeIdFromPath, isSessionRouteId, type RouteId } from "../app-route-paths.ts";
import { hasIdleWarmups, takeIdleWarmups } from "../lib/idle-warmup.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { ShellOwner } from "./app-host.tsx";
import type { ApplicationContext } from "./context.ts";
import { connectControlUiFavicon } from "./control-ui-favicon-status.runtime.ts";

function canPreload(): boolean {
  // SAFETY: Network Information is optional and is not in TypeScript's DOM library.
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return navigator.onLine && !connection?.saveData && document.visibilityState === "visible";
}

/** Optional shell services share the existing deferred import and its lifetime. */
export function connectShellIdle(
  host: ShellOwner,
  context: ApplicationContext,
  startedAt: number,
): () => void {
  const stopFavicon = connectControlUiFavicon(
    host.element,
    context,
    () => host.queryRenderedElements("openclaw-chat-pane"),
    startedAt,
  );
  const { router, gateway, basePath, resourceBasePath, preload: warmRoute } = context;
  const shell = host.element;
  const outlet = () => host.routeOutlet;
  const transcriptsReady = () => {
    const panes = host
      .queryRenderedElements("openclaw-chat-pane")
      .filter((pane) => pane.presented && pane.visuallyPresented);
    const routeId = context.router.getState().matches[0]?.routeId;
    const pluginsReady = host
      .queryRenderedElements("openclaw-plugin-page")
      .every((page) => !context.plugins.isLoading(page.pluginId ?? ""));
    return (
      pluginsReady &&
      (!routeId || !isSessionRouteId(routeId) || panes.length > 0) &&
      panes.every(
        (pane) =>
          !pane.conversationPresented ||
          (pane.transcriptReady && !pane.transcriptLoading && pane.composerReady),
      )
    );
  };
  const descriptor = document
    .getElementById("openclaw-navigation-preloads")
    ?.getAttribute("content");
  const base = new URL(`${resourceBasePath.replace(/\/$/u, "")}/`, location.origin);
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
    const currentRoute = router.getState().matches[0]?.routeId;
    const currentNext =
      currentRoute === "new-session" && context.theme.settings.sidebarAgentsMode === "roster"
        ? "roster-next"
        : currentRoute
          ? `${currentRoute}-next`
          : undefined;
    if (currentNext && manifest?.[currentNext]) {
      return pending.has(currentNext) ? currentNext : undefined;
    }
    return pending.has("new-session") ? "new-session" : undefined;
  };
  const available = () => {
    const state = router.getState();
    return (
      active &&
      canPreload() &&
      gateway.snapshot.phase === "connected" &&
      state.status === "success" &&
      state.pendingMatches.length === 0
    );
  };
  const ready = () => available() && outlet()?.presentationSettled === true && transcriptsReady();
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
    if (!available() || running || (manifest && !nextPending() && !hasIdleWarmups())) {
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
      // Current-page menu bodies precede next-route guesses; navigation intent still wins.
      const warmups = intent ? [] : takeIdleWarmups();
      if (warmups.length) {
        // Speculation only; opening the surface owns any load failure.
        await Promise.all(warmups.map((load) => load().catch(() => undefined)));
        return;
      }
      const currentRoute = router.getState().matches[0]?.routeId;
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
        // Plugin activation owns its styles; roster warming only applies host Chat CSS.
        const applyStyle =
          key === "roster-next" && file.endsWith(".css") && !file.startsWith("assets/plugins/");
        const styleApplied = () =>
          [...document.styleSheets].some((stylesheet) => stylesheet.href === href);
        if (seen.has(href) && (!applyStyle || styleApplied())) {
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
            const stopLoad = listen(
              link,
              "load",
              () => {
                if (applyStyle && !styleApplied()) {
                  // Keep Chat's style matching out of Create Claw, but its JS lazy.
                  // Vite adopts this loaded sheet; it must outlive the idle owner.
                  link.rel = "stylesheet";
                  link.removeAttribute("as");
                  links.delete(link);
                }
                finish();
              },
              { once: true },
            );
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
      router.getState().matches[0]?.routeId === routeId
    ) {
      return;
    }
    prioritize(routeId === "config" ? "appearance" : routeId);
    try {
      await warmRoute(routeId);
    } catch {
      // Actual navigation owns route-load failures.
    }
  };
  const onIntent = (event: Event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    const routeId = anchor ? routeIdFromPath(anchor.pathname, basePath) : null;
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
        void warmRoute("appearance").catch(() => undefined);
      }
    }
  };
  const stops = [
    router.subscribe(schedule),
    gateway.subscribe(schedule),
    context.theme.subscribe(schedule),
    listen(shell, "pointerover", onIntent),
    listen(shell, "pointerout", onIntent),
    listen(shell, "focusin", onIntent),
    listen(shell, "focusout", onIntent),
    listen(shell, "touchstart", onIntent, { passive: true }),
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
    stopFavicon();
  };
}
