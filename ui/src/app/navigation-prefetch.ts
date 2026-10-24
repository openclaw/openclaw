import { listen } from "../lib/reactive/listener.ts";
import { canPreload } from "../lib/route-preload.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";

/** Fetch and compile code without evaluating modules or applying route styles. */
export function connectNavigationPrefetch(options: {
  shell: HTMLElement;
  router: Pick<ApplicationContext["router"], "getState" | "subscribe">;
  gateway: Pick<ApplicationContext["gateway"], "snapshot" | "subscribe">;
  outlet: () => Pick<ControlUiReadinessOutlet, "presentationSettled"> | undefined;
  resourceBasePath: string;
  transcriptsReady: () => boolean;
}): () => void {
  const descriptor = document
    .getElementById("openclaw-navigation-preloads")
    ?.getAttribute("content");
  if (!descriptor) {
    return () => {};
  }
  const base = new URL(`${options.resourceBasePath.replace(/\/$/u, "")}/`, location.origin);
  const pending = new Set<string>();
  const seen = new Set(performance.getEntriesByType("resource").map((entry) => entry.name));
  const links = new Map<HTMLLinkElement, () => void>();
  const abort = new AbortController();
  let manifest: Record<string, string[]> | undefined;
  let active = true;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let intent: string | undefined;
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
    if (!available() || running || (manifest && pending.size === 0)) {
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
      if (!manifest) {
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
      const key = intent && pending.has(intent) ? intent : pending.values().next().value;
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
  const onIntent = (event: Event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const key = event.target.closest(".topbar-search")
      ? "palette"
      : event.target.closest(".chat-controls__model-trigger")
        ? "model-picker"
        : event.target.closest('[data-value="command:settings"]')
          ? "appearance"
          : event.target.closest('[data-value="command:debug-overlay"]')
            ? "debug"
            : undefined;
    if (key && (!manifest || pending.has(key))) {
      intent = key;
      if (!running && ready()) {
        cancel();
        void warm();
      }
    }
  };
  const stops = [
    options.router.subscribe(schedule),
    options.gateway.subscribe(schedule),
    listen(options.shell, "pointerover", onIntent),
    listen(options.shell, "focusin", onIntent),
    listen(document, "visibilitychange", schedule),
    listen(window, "online", schedule),
  ];
  schedule();
  return () => {
    active = false;
    cancel();
    abort.abort();
    stops.forEach((stop) => stop());
    links.forEach((finish, link) => {
      finish();
      link.remove();
    });
  };
}
