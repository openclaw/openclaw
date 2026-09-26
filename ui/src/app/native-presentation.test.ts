import { createRouter, definePage } from "@openclaw/uirouter";
import { html, LitElement, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-route-paths.ts";
import { renderLazyViewError } from "../components/lazy-view-error.ts";
import { renderConnectingSplash } from "../components/loading-skeleton.ts";
import { renderPanelLoadingSkeleton } from "../components/panel-loading-skeleton.ts";
import { renderSettingsLoadingSkeleton } from "../components/settings-ui.ts";
import { createBackgroundTasksProps } from "../pages/chat/components/chat-background-tasks.ts";
import { renderChatTasksPanel } from "../pages/chat/components/chat-tasks-panel.ts";
import {
  createContext as createCronContext,
  createGateway as createCronGateway,
  createPage as createCronPage,
  createRequest,
} from "../pages/cron/cron-page.test-support.ts";
import { createCronViewJob } from "../pages/cron/view.test-support.ts";
import "../pages/cron/cron-page.ts";
import { createHost, makeTask } from "../test-helpers/chat-background-tasks.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";
import { startNativePresentation } from "./native-presentation.runtime.ts";
import {
  NATIVE_PRESENTATION_STATE_EVENT,
  NATIVE_PRESENTATION_REQUEST_EVENT,
  type NativePresentationState,
} from "./native-web-chrome.ts";
import "./router-outlet.ts";

const cleanups: (() => void)[] = [];

class NativePresentationPanelFixture extends LitElement {
  static override properties = { loaded: { type: Boolean } };
  loaded = false;
  override render() {
    return this.loaded
      ? html`<p>Loaded panel</p>`
      : renderPanelLoadingSkeleton("tasks", "Loading tasks");
  }
}
customElements.define("native-presentation-panel-fixture", NativePresentationPanelFixture);

function gateway() {
  const store = createGatewayStoreTestStore();
  cleanups.push(() => store.gateway.stop());
  store.gateway.start();
  store.current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  return store.gateway;
}

function recordStates() {
  const states: NativePresentationState[] = [];
  vi.stubGlobal("__OPENCLAW_NATIVE_PANEL__", { postMessage: vi.fn() });
  const record = (event: Event) =>
    states.push((event as CustomEvent<NativePresentationState>).detail);
  window.addEventListener(NATIVE_PRESENTATION_STATE_EVENT, record);
  cleanups.push(() => window.removeEventListener(NATIVE_PRESENTATION_STATE_EVENT, record));
  return states;
}

function nextReady(pathname: string) {
  const next = createDeferred<NativePresentationState>();
  const listener = (event: Event) => {
    const state = (event as CustomEvent<NativePresentationState>).detail;
    if (state.pathname === pathname && state.phase === "ready") {
      window.removeEventListener(NATIVE_PRESENTATION_STATE_EVENT, listener);
      next.resolve(state);
    }
  };
  window.addEventListener(NATIVE_PRESENTATION_STATE_EVENT, listener);
  cleanups.push(() => window.removeEventListener(NATIVE_PRESENTATION_STATE_EVENT, listener));
  return next.promise;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  document.body.replaceChildren();
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("holds native presentation through nested shadow loading, then keeps background refresh visible", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const states = recordStates();
  const routeData = createDeferred();
  const router = createRouter<RouteId, undefined, { render(): unknown }>({
    routes: [
      definePage({
        id: "settings",
        path: "/settings",
        loader: () => routeData.promise,
        component: () => ({
          render: () =>
            html`<native-presentation-panel-fixture></native-presentation-panel-fixture>`,
        }),
      }),
    ],
  });
  const outlet = document.createElement("openclaw-router-outlet") as LitElement & {
    router: typeof router;
  };
  outlet.router = router;
  document.body.append(outlet);
  const connected = gateway();
  cleanups.push(() => router.stop(), startNativePresentation({ router, gateway: connected }));
  const navigation = router.navigate("settings", undefined);
  expect(states.at(-1)).toMatchObject({ pathname: "/settings", phase: "loading" });
  routeData.resolve();
  await navigation;
  await settleLitElement(outlet);
  const panel = outlet.querySelector<NativePresentationPanelFixture>(
    "native-presentation-panel-fixture",
  )!;
  await panel.updateComplete;
  expect(states.some((state) => state.phase === "ready")).toBe(false);
  const ready = nextReady("/settings");
  panel.loaded = true;
  await panel.updateComplete;
  const settled = await ready;
  expect(settled.generation).toBe(states.at(-1)?.generation);
  const published = states.length;
  panel.loaded = false;
  await panel.updateComplete;
  expect(states).toHaveLength(published);
});

it("fences superseded route completion and reveals a committed failure without waiting for a frame", async () => {
  const states = recordStates();
  const stale = createDeferred();
  const failed = createDeferred();
  const router = createRouter<RouteId, undefined, { render(): unknown }>({
    routes: [
      definePage({
        id: "settings",
        path: "/settings",
        loader: () => stale.promise,
        component: () => ({ render: () => renderSettingsLoadingSkeleton() }),
      }),
      definePage({
        id: "cron",
        path: "/automations",
        loader: () => failed.promise,
        component: () => ({ render: () => html`<p>Automations</p>` }),
      }),
    ],
  });
  const outlet = document.createElement("openclaw-router-outlet") as LitElement & {
    router: typeof router;
  };
  outlet.router = router;
  document.body.append(outlet);
  cleanups.push(() => router.stop(), startNativePresentation({ router, gateway: gateway() }));
  const oldNavigation = router.navigate("settings", undefined).catch(() => undefined);
  const oldGeneration = states.at(-1)?.generation;
  const navigation = router.navigate("cron", undefined).catch(() => undefined);
  const currentGeneration = states.at(-1)?.generation;
  expect(currentGeneration).toBeGreaterThan(oldGeneration!);
  stale.resolve();
  await oldNavigation;
  await settleLitElement(outlet);
  expect(states.some((state) => state.phase === "ready")).toBe(false);
  const ready = nextReady("/automations");
  failed.reject(new Error("Synthetic request failed"));
  await navigation;
  expect(await ready).toMatchObject({ generation: currentGeneration, pathname: "/automations" });
  expect(outlet.textContent).toContain("Synthetic request failed");
});

it("ignores retained hidden loading content and stops publishing after disposal", async () => {
  const states = recordStates();
  const root = document.createElement("div");
  root.innerHTML =
    "<section hidden><div data-openclaw-presentation-pending></div></section><p>Ready content</p>";
  document.body.append(root);
  const router = createRouter<RouteId, undefined>({
    routes: [definePage({ id: "settings", path: "/settings", component: () => ({}) })],
  });
  await router.navigate("settings", undefined);
  const ready = nextReady("/settings");
  const stop = startNativePresentation({ router, gateway: gateway() });
  cleanups.push(() => router.stop(), stop);
  await ready;
  const current = states.at(-1);
  const initialCount = states.length;
  window.dispatchEvent(new Event(NATIVE_PRESENTATION_REQUEST_EVENT));
  expect(states).toHaveLength(initialCount + 1);
  expect(states.at(-1)).toEqual(current);
  stop();
  const published = states.length;
  root.setAttribute("data-openclaw-presentation-pending", "");
  window.dispatchEvent(new Event(NATIVE_PRESENTATION_REQUEST_EVENT));
  await Promise.resolve();
  expect(states).toHaveLength(published);
  expect(Reflect.get(window, "__OPENCLAW_NATIVE_PRESENTATION__")).toBeUndefined();
  root.removeAttribute("data-openclaw-presentation-pending");
  const restarted = nextReady("/settings");
  cleanups.push(startNativePresentation({ router, gateway: gateway() }));
  expect((await restarted).generation).toBeGreaterThan(current!.generation);
});

it("keeps a connected document masked until its initial route exists and commits", async () => {
  const states = recordStates();
  const router = createRouter<RouteId, undefined>({
    routes: [
      definePage({
        id: "settings",
        path: "/settings",
        component: () => ({ render: () => html`<p>Settings ready</p>` }),
      }),
    ],
  });
  cleanups.push(() => router.stop(), startNativePresentation({ router, gateway: gateway() }));
  await Promise.resolve();
  await Promise.resolve();
  expect(router.getState().status).toBe("idle");
  expect(states.some((state) => state.phase === "ready")).toBe(false);
  const outlet = document.createElement("openclaw-router-outlet") as LitElement & {
    router: typeof router;
  };
  outlet.router = router;
  document.body.append(outlet);
  const ready = nextReady("/settings");
  await router.navigate("settings", undefined);
  await ready;
  expect(outlet.textContent).toContain("Settings ready");
});

it.each([false, true])(
  "waits for an Automation deep link's own job request (failure: %s)",
  async (fail) => {
    const states = recordStates();
    const job = createCronViewJob("native-ready-job", { name: "Native ready automation" });
    const requested = createDeferred();
    const result = createDeferred<typeof job>();
    const fallback = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "cron.get") {
        requested.resolve();
        return result.promise;
      }
      return fallback(method);
    });
    const connected = createCronGateway({ request } as unknown as GatewayBrowserClient, true);
    const router = createRouter<RouteId, undefined>({
      routes: [
        definePage({
          id: "cron",
          path: "/automations",
          component: () => ({}),
        }),
      ],
    });
    const search = "?job=native-ready-job";
    await router.navigate("cron", undefined, {}, { pathname: "/automations", search, hash: "" });
    const page = createCronPage(createCronContext(connected), { render: true });
    page.routeSearch = search;
    cleanups.push(() => router.stop(), startNativePresentation({ router, gateway: connected }));
    await requested.promise;
    await page.updateComplete;
    expect(states.some((state) => state.phase === "ready")).toBe(false);
    const ready = nextReady("/automations");
    if (fail) {
      result.reject(new Error("Synthetic job unavailable"));
    } else {
      result.resolve(job);
    }
    expect(await ready).toMatchObject({ pathname: "/automations", search });
    if (fail) {
      expect(page.textContent).toContain("Synthetic job unavailable");
    } else {
      expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
        "Native ready automation",
      );
    }
  },
);

it("keeps connection recovery masked until its error content replaces the loading shell", async () => {
  const states = recordStates();
  const router = createRouter<RouteId, undefined>({ routes: [] });
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  store.current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  const root = document.createElement("div");
  document.body.append(root);
  render(renderConnectingSplash(), root);
  cleanups.push(
    () => router.stop(),
    () => store.gateway.stop(),
    startNativePresentation({ router, gateway: store.gateway }),
  );
  await Promise.resolve();
  expect(states.some((state) => state.phase === "ready")).toBe(false);
  store
    .current()
    .opts.onClose?.({ code: 4008, reason: "Synthetic connect failure", willRetry: false });
  await vi.dynamicImportSettled();
  expect(states.some((state) => state.phase === "ready")).toBe(false);
  const ready = nextReady(window.location.pathname);
  render(
    renderLazyViewError({ error: new Error("Synthetic connection recovery"), onRetry: () => {} }),
    root,
  );
  expect((await ready).phase).toBe("ready");
  expect(root.textContent).toContain("Synthetic connection recovery");
  expect(store.gateway.snapshot.lastError).toContain("4008");
});

it.each(["empty", "error", "detail"] as const)(
  "waits through embedded Tasks admission before revealing its first %s result",
  async (outcome) => {
    const states = recordStates();
    const response = createDeferred<unknown>();
    const task = makeTask({
      id: "native-ready-task",
      status: "completed",
      title: "Loaded task detail",
    });
    const { host, request, requestUpdate } = createHost({
      connected: true,
      request: (method) =>
        outcome === "detail" && method === "tasks.list"
          ? Promise.resolve({ tasks: [] })
          : response.promise,
    });
    let admitted = false;
    host.chatSecondaryReadsReady = () => admitted;
    const mount = document.body.appendChild(document.createElement("div"));
    const renderPanel = () =>
      render(
        renderChatTasksPanel({
          host,
          backgroundTasks: createBackgroundTasksProps(
            host,
            outcome === "detail" ? { selectedTaskId: task.id } : {},
          ),
        }),
        mount,
      );
    requestUpdate.mockImplementation(() => queueMicrotask(renderPanel));
    const router = createRouter<RouteId, undefined>({
      routes: [
        definePage({
          id: "panel-embed",
          path: "/apps/panel",
          component: () => ({}),
        }),
      ],
    });
    await router.navigate("panel-embed", undefined);
    renderPanel();
    cleanups.push(() => router.stop(), startNativePresentation({ router, gateway: gateway() }));
    await vi.dynamicImportSettled();
    expect(createBackgroundTasksProps(host)).toMatchObject({
      tasks: null,
      loading: false,
      connected: true,
    });
    expect(states.some((state) => state.phase === "ready")).toBe(false);
    expect(request).not.toHaveBeenCalled();
    admitted = true;
    renderPanel();
    if (outcome === "detail") {
      admitted = false;
    }
    await vi.dynamicImportSettled();
    expect(request).toHaveBeenCalledWith("tasks.list", expect.anything());
    expect(states.some((state) => state.phase === "ready")).toBe(false);
    if (outcome === "detail") {
      expect(request).not.toHaveBeenCalledWith("tasks.get", expect.anything());
      admitted = true;
      renderPanel();
      expect(request).toHaveBeenCalledWith("tasks.get", { taskId: task.id });
    }
    const ready = nextReady("/apps/panel");
    if (outcome === "error") {
      response.reject(new Error("Synthetic task load failed"));
    } else {
      response.resolve(outcome === "detail" ? { task } : { tasks: [] });
    }
    await ready;
    expect(mount.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    if (outcome === "empty") {
      expect(mount.querySelector("openclaw-panel-empty-state")).not.toBeNull();
    } else {
      expect(mount.textContent).toContain(
        outcome === "error" ? "Synthetic task load failed" : "Loaded task detail",
      );
    }
  },
);
