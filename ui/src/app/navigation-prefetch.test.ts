// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationRouter } from "../app-routes.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import { connectNavigationPrefetch } from "./navigation-prefetch.ts";

const cleanups: Array<() => void> = [];
const idleCallbacks: Array<() => void> = [];
const connection = { saveData: false };
const manifest = {
  "new-session": ["assets/new-1234abcd.js", "assets/new-1234abcd.css"],
  claws: ["assets/claws-1234abcd.js"],
  palette: ["assets/palette-1234abcd.js"],
  "model-picker": ["assets/model-picker-1234abcd.js"],
  appearance: ["assets/appearance-1234abcd.js"],
  debug: ["assets/debug-1234abcd.js"],
  "advanced-next": ["assets/security-1234abcd.js", "assets/security-1234abcd.css"],
  "claws-next": ["assets/claws-next-1234abcd.js"],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => idleCallbacks.push(callback));
  vi.stubGlobal("cancelIdleCallback", () => idleCallbacks.splice(0));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => manifest })),
  );
  Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
  connection.saveData = false;
  const meta = document.createElement("meta");
  meta.id = "openclaw-navigation-preloads";
  meta.content = "assets/navigation-preloads-1234abcd.json";
  document.head.append(meta);
  cleanups.push(() => meta.remove());
});

afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  idleCallbacks.length = 0;
  Reflect.deleteProperty(navigator, "connection");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(routeId?: "advanced") {
  const currentLocation = {
    pathname: routeId ? "/control/settings/advanced" : "/chat",
    search: "",
    hash: "",
  };
  const state: ReturnType<ApplicationRouter["getState"]> = {
    location: currentLocation,
    resolvedLocation: routeId ? currentLocation : null,
    status: "success",
    matches: [],
    pendingMatches: [],
    cachedMatches: [],
  };
  if (routeId) {
    state.matches = [
      {
        id: routeId,
        routeId,
        location: currentLocation,
        deps: "",
        status: "success",
        isFetching: false,
        updatedAt: 0,
        fetchCount: 1,
        abortController: new AbortController(),
        cause: "navigation",
        preload: false,
        invalid: false,
      },
    ];
  }
  let notify = () => {};
  const outlet = { presentationSettled: false };
  const transcript = { ready: false };
  const shell = document.body.appendChild(document.createElement("div"));
  const preloadRoute = vi.fn(async () => {});
  const stop = connectNavigationPrefetch({
    shell,
    basePath: "/control",
    resourceBasePath: "/control",
    router: {
      getState: () => state,
      subscribe: (listener) => {
        notify = () => listener(state);
        return () => true;
      },
    },
    gateway: {
      snapshot: createApplicationGatewaySnapshot({
        phase: "connected",
        assistantAgentId: "main",
        sessionKey: "main",
      }),
      subscribe: () => () => {},
    },
    outlet: () => outlet,
    transcriptsReady: () => transcript.ready,
    preloadRoute,
  });
  cleanups.push(stop, () => shell.remove());
  return { state, outlet, transcript, shell, stop, preloadRoute, notify: () => notify() };
}

const hints = () =>
  [...document.head.querySelectorAll<HTMLLinkElement>("link")].filter((link) =>
    link.href.startsWith(new URL("/control/assets/", location.origin).href),
  );
async function idle() {
  await vi.advanceTimersByTimeAsync(500);
  idleCallbacks.shift()?.();
  await vi.advanceTimersByTimeAsync(0);
}

it("warms New Session after presentation and leaves other routes for intent", async () => {
  const fixture = setup();
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  fixture.outlet.presentationSettled = true;
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  fixture.transcript.ready = true;
  await idle();
  expect(fetch).toHaveBeenCalledWith(
    new URL("/control/assets/navigation-preloads-1234abcd.json", location.origin),
    expect.anything(),
  );
  expect(
    hints().map((link) => [link.rel, link.as ?? "", link.getAttribute("href"), link.fetchPriority]),
  ).toEqual([
    ["modulepreload", "", new URL("/control/assets/new-1234abcd.js", location.origin).href, "low"],
    ["preload", "style", new URL("/control/assets/new-1234abcd.css", location.origin).href, "low"],
  ]);
  await idle();
  expect(hints()).toHaveLength(2);
  fixture.state.status = "loading";
  fixture.notify();
  hints().forEach((link) => link.dispatchEvent(new Event("load")));
  await idle();
  expect(hints()).toHaveLength(2);
  fixture.state.status = "success";
  fixture.notify();
  await idle();
  expect(hints()).toHaveLength(2);
  const claws = fixture.shell.appendChild(document.createElement("a"));
  claws.className = "nav-item";
  claws.href = "/control/claws";
  claws.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(hints().map((link) => link.href)).toContain(
    new URL("/control/assets/claws-1234abcd.js", location.origin).href,
  );
  expect(fixture.preloadRoute).toHaveBeenCalledExactlyOnceWith("claws");
  fixture.stop();
  await idle();
  expect(hints()).toHaveLength(0);
});

it("keeps declared next interactions as the route's only automatic idle work", async () => {
  const fixture = setup("advanced");
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  fixture.outlet.presentationSettled = true;
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  fixture.transcript.ready = true;
  await idle();
  expect(hints().map((link) => [link.rel, link.as ?? "", link.href])).toEqual([
    ["modulepreload", "", new URL("/control/assets/security-1234abcd.js", location.origin).href],
    ["preload", "style", new URL("/control/assets/security-1234abcd.css", location.origin).href],
  ]);
  expect(fixture.preloadRoute).not.toHaveBeenCalled();
  expect(document.querySelector("script")).toBeNull();
  fixture.state.status = "loading";
  fixture.notify();
  hints().forEach((link) => link.dispatchEvent(new Event("load")));
  await idle();
  expect(hints()).toHaveLength(2);
  const nextLocation = { pathname: "/control/claws", search: "", hash: "" };
  fixture.state.location = nextLocation;
  fixture.state.resolvedLocation = nextLocation;
  fixture.state.matches = [
    { ...fixture.state.matches[0]!, id: "claws", routeId: "claws", location: nextLocation },
  ];
  fixture.state.status = "success";
  fixture.notify();
  await idle();
  expect(hints().map((link) => link.href)).toEqual([
    new URL("/control/assets/security-1234abcd.js", location.origin).href,
    new URL("/control/assets/security-1234abcd.css", location.origin).href,
    new URL("/control/assets/claws-next-1234abcd.js", location.origin).href,
  ]);
  hints().forEach((link) => link.dispatchEvent(new Event("load")));
  await idle();
  expect(hints()).toHaveLength(3);
  const fallbackLocation = { pathname: "/control/usage", search: "", hash: "" };
  fixture.state.location = fallbackLocation;
  fixture.state.resolvedLocation = fallbackLocation;
  fixture.state.matches = [
    { ...fixture.state.matches[0]!, id: "usage", routeId: "usage", location: fallbackLocation },
  ];
  fixture.notify();
  await idle();
  expect(hints().map((link) => link.href)).toEqual([
    new URL("/control/assets/security-1234abcd.js", location.origin).href,
    new URL("/control/assets/security-1234abcd.css", location.origin).href,
    new URL("/control/assets/claws-next-1234abcd.js", location.origin).href,
    new URL("/control/assets/new-1234abcd.js", location.origin).href,
    new URL("/control/assets/new-1234abcd.css", location.origin).href,
  ]);
  expect(fixture.preloadRoute).not.toHaveBeenCalled();
});

it.each(["topbar-search", "sidebar-brand__search", "shell-chrome-controls__search"])(
  "prioritizes %s intent without mounting and rechecks Save-Data at effect time",
  async (searchClass) => {
    const fixture = setup("advanced");
    fixture.outlet.presentationSettled = true;
    fixture.transcript.ready = true;
    const trigger = fixture.shell.appendChild(document.createElement("button"));
    trigger.className = searchClass;
    connection.saveData = true;
    trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await idle();
    expect(fetch).not.toHaveBeenCalled();
    connection.saveData = false;
    trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hints().map((link) => link.href)).toEqual([
      new URL("/control/assets/palette-1234abcd.js", location.origin).href,
    ]);
    expect(fixture.shell.children).toHaveLength(1);

    trigger.className = "chat-controls__model-trigger";
    trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    hints().forEach((link) => link.dispatchEvent(new Event("load")));
    await idle();
    expect(hints().map((link) => link.href)).toContain(
      new URL("/control/assets/model-picker-1234abcd.js", location.origin).href,
    );

    trigger.className = "";
    trigger.dataset.value = "command:settings";
    trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    hints().forEach((link) => link.dispatchEvent(new Event("load")));
    await idle();
    expect(hints().map((link) => link.href)).toContain(
      new URL("/control/assets/appearance-1234abcd.js", location.origin).href,
    );

    trigger.dataset.value = "command:debug-overlay";
    trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    hints().forEach((link) => link.dispatchEvent(new Event("load")));
    await idle();
    expect(hints().map((link) => link.href)).toContain(
      new URL("/control/assets/debug-1234abcd.js", location.origin).href,
    );
  },
);

it("uses navigation hrefs and rechecks readiness before applying delayed intent", async () => {
  const fixture = setup();
  fixture.outlet.presentationSettled = true;
  fixture.transcript.ready = true;
  const pin = fixture.shell.appendChild(document.createElement("div"));
  pin.className = "sidebar-rail__pin";
  const trigger = pin.appendChild(document.createElement("a"));
  trigger.className = "nav-item";
  trigger.href = "/control/sessions";
  trigger.dispatchEvent(new Event("pointerover", { bubbles: true }));
  connection.saveData = true;
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).not.toHaveBeenCalled();

  connection.saveData = false;
  trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
  trigger.dispatchEvent(new Event("focusout", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).not.toHaveBeenCalled();
  trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).toHaveBeenCalledExactlyOnceWith("sessions");
  fixture.state.status = "loading";
  trigger.dispatchEvent(new Event("touchstart", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.preloadRoute).toHaveBeenCalledTimes(1);
  fixture.state.status = "success";
  trigger.dispatchEvent(new Event("touchstart", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.preloadRoute).toHaveBeenCalledTimes(2);
});

it("uses existing active and disabled state and recognizes New Session outside navigation", async () => {
  const fixture = setup();
  fixture.outlet.presentationSettled = true;
  fixture.transcript.ready = true;
  const trigger = fixture.shell.appendChild(document.createElement("a"));
  trigger.className = "settings-sidebar__item";
  trigger.href = "/control/settings/model-providers";
  trigger.setAttribute("aria-current", "page");
  trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).not.toHaveBeenCalled();
  trigger.removeAttribute("aria-current");
  trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
  trigger.setAttribute("aria-disabled", "true");
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).not.toHaveBeenCalled();
  trigger.removeAttribute("aria-disabled");
  trigger.className = "";
  trigger.href = "/control/new?agent=main";
  trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).toHaveBeenCalledExactlyOnceWith("new-session");
  trigger.href = "/control/sessions";
  trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).toHaveBeenCalledTimes(1);
});

it("keeps native route intent in development without a built asset descriptor", async () => {
  document.getElementById("openclaw-navigation-preloads")?.remove();
  const fixture = setup();
  fixture.outlet.presentationSettled = true;
  fixture.transcript.ready = true;
  const trigger = fixture.shell.appendChild(document.createElement("a"));
  trigger.className = "settings-sidebar__item";
  trigger.href = "/control/automations";
  trigger.dispatchEvent(new Event("focusin", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).toHaveBeenCalledExactlyOnceWith("cron");
  expect(fetch).not.toHaveBeenCalled();
  expect(hints()).toHaveLength(0);
  trigger.dispatchEvent(new Event("pointerover", { bubbles: true }));
  fixture.stop();
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.preloadRoute).toHaveBeenCalledTimes(1);
});
