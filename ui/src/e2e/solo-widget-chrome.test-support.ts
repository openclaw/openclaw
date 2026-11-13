import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Page } from "playwright";

function installDashboardMenuDiagnostics() {
  if (window !== window.top) {
    return;
  }
  const events: Record<string, unknown>[] = [];
  const identities = new WeakMap<Node, number>();
  const menus = new Set<HTMLElement>();
  let nextIdentity = 0;
  let sequence = 0;
  let dropped = 0;
  let gestureMenu: HTMLElement | undefined;
  const identity = (node: Node | undefined) => {
    if (!node) {
      return undefined;
    }
    let id = identities.get(node);
    if (id === undefined) {
      id = ++nextIdentity;
      identities.set(node, id);
    }
    return id;
  };
  const record = (event: Event, listenerPhase: "capture" | "bubble") => {
    const eventPath = event.composedPath();
    const owner = eventPath.find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches(".chat-dashboard-menu"),
    );
    if (event.type === "pointerdown") {
      gestureMenu = owner;
    }
    const continuation =
      event.type === "pointerup" ||
      event.type === "pointercancel" ||
      (event.type === "click" && event instanceof MouseEvent && event.detail > 0);
    const menu = owner ?? (continuation ? gestureMenu : undefined);
    if (!menu) {
      return;
    }
    if (!menus.has(menu)) {
      menus.add(menu);
      for (const type of lifecycleTypes) {
        menu.addEventListener(type, capture, true);
        menu.addEventListener(type, bubble);
      }
    }
    const target = eventPath.find((node): node is Node => node instanceof Node);
    const row = eventPath.find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches('[role^="menuitem"]'),
    );
    const surface = menu.querySelector<HTMLElement>(".oc-menu");
    const trigger = menu.querySelector<HTMLElement>(".chat-dashboard-menu__trigger");
    // Keep fixture diagnostics free of labels, content, URLs, and arbitrary action values.
    const action = row?.dataset.value;
    const phase = surface?.dataset.phase;
    events.push({
      sequence: ++sequence,
      time: performance.now(),
      type: event.type,
      listenerPhase,
      defaultPrevented: event.defaultPrevented,
      trusted: event.isTrusted,
      target: identity(target),
      row: identity(row),
      menu: identity(menu),
      surface: identity(surface ?? undefined),
      trigger: identity(trigger ?? undefined),
      action:
        action === undefined
          ? undefined
          : ["dashboard-expand", "resize:xl"].includes(action)
            ? action
            : "other",
      phase: phase && ["hidden", "opening", "open", "closing"].includes(phase) ? phase : undefined,
      nativeOpen: surface?.matches(":popover-open"),
      inert: surface?.inert,
      connected: menu.isConnected,
      rowConnected: row?.isConnected,
      expanded: trigger?.getAttribute("aria-expanded") === "true",
      pointer:
        event instanceof MouseEvent
          ? { x: event.clientX, y: event.clientY, button: event.button }
          : undefined,
    });
    if (events.length > 128) {
      events.shift();
      dropped += 1;
    }
    if (listenerPhase === "bubble" && ["click", "pointercancel"].includes(event.type)) {
      gestureMenu = undefined;
    }
  };
  const capture = (event: Event) => record(event, "capture");
  const bubble = (event: Event) => record(event, "bubble");
  const types = ["pointerdown", "pointerup", "pointercancel", "click"];
  // Menu selection is not composed across the chat pane's shadow root.
  const lifecycleTypes = ["menu-select", "overlay-show", "overlay-hide"];
  for (const type of types) {
    document.addEventListener(type, capture, true);
    document.addEventListener(type, bubble);
  }
  Reflect.set(window, "__widgetChromeMenuDiagnostics", () => {
    for (const type of types) {
      document.removeEventListener(type, capture, true);
      document.removeEventListener(type, bubble);
    }
    for (const menu of menus) {
      for (const type of lifecycleTypes) {
        menu.removeEventListener(type, capture, true);
        menu.removeEventListener(type, bubble);
      }
    }
    menus.clear();
    gestureMenu = undefined;
    Reflect.deleteProperty(window, "__widgetChromeMenuDiagnostics");
    return { limit: 128, dropped, events };
  });
}

/** The suite owns screenshots and RPC diagnostics; retain menu events and the trace on failure. */
export async function withWidgetChromeDiagnostics(
  page: Page,
  artifactDir: () => string,
  run: () => Promise<void>,
): Promise<void> {
  const context = page.context();
  await page.addInitScript(installDashboardMenuDiagnostics);
  await context.tracing.start({ screenshots: true, snapshots: true });
  try {
    await run();
  } catch (error) {
    try {
      await withTimeout(
        (async () => {
          const events = await page.evaluate(() =>
            Reflect.get(window, "__widgetChromeMenuDiagnostics")?.(),
          );
          if (events) {
            await writeFile(
              path.join(artifactDir(), "widget-chrome-state.json"),
              JSON.stringify(events, null, 2) + "\n",
            );
          }
        })(),
        5_000,
        "widget chrome menu event capture",
      );
    } catch (captureError) {
      console.error(`[single-widget-chrome] menu event capture failed: ${String(captureError)}`);
    }
    try {
      await withTimeout(
        context.tracing.stop({ path: path.join(artifactDir(), "widget-chrome-trace.zip") }),
        5_000,
        "widget chrome trace capture",
      );
    } catch (captureError) {
      console.error(`[single-widget-chrome] trace capture failed: ${String(captureError)}`);
    }
    throw error;
  } finally {
    await withTimeout(
      page.evaluate(() => Reflect.get(window, "__widgetChromeMenuDiagnostics")?.()),
      5_000,
      "widget chrome menu diagnostic cleanup",
    ).catch((captureError: unknown) => {
      console.error(
        `[single-widget-chrome] menu diagnostic cleanup failed: ${String(captureError)}`,
      );
    });
  }
  await context.tracing.stop();
}
