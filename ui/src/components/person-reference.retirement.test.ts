/* @vitest-environment jsdom */
import { ContextProvider } from "@lit/context";
import { render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { renderChatPagePaneCell } from "../pages/chat/chat-page-pane-render.ts";
import { RouteDraftComposerFocus } from "../pages/chat/route-draft-focus-handoff.ts";
import * as activityModule from "./person-activity-data.ts";
import "./person-reference.ts";

const activities: Array<{
  dispose: MockInstance<ReturnType<typeof activityModule.observePersonActivityData>["dispose"]>;
}> = [];
const routeListeners = new Set<() => void>();
const gatewayListeners = new Set<() => void>();
let providerHost: HTMLDivElement;
let retained: HTMLDivElement;
let reference: HTMLElement & LitElement;
let button: HTMLButtonElement;
let request: ReturnType<typeof vi.fn>;

let add: MockInstance<typeof document.addEventListener>;
let remove: MockInstance<typeof document.removeEventListener>;
const hover = () =>
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
const portal = () => document.querySelector(".person-activity-hovercard");
const activeDocumentHandlers = () => {
  const registered = new Map<string, Set<unknown>>();
  const changes = [
    ...add.mock.calls.map((call, i) => {
      const order = add.mock.invocationCallOrder[i];
      if (order === undefined) {
        throw new Error("Expected invocation order for recorded addEventListener call");
      }
      return { call, add: true, order };
    }),
    ...remove.mock.calls.map((call, i) => {
      const order = remove.mock.invocationCallOrder[i];
      if (order === undefined) {
        throw new Error("Expected invocation order for recorded removeEventListener call");
      }
      return { call, add: false, order };
    }),
  ].toSorted((a, b) => a.order - b.order);
  for (const change of changes) {
    const [type, handler, capture] = change.call;
    if (!["pointerdown", "focusin", "keydown"].includes(type) || capture !== true) {
      continue;
    }
    const handlers = registered.get(type) ?? new Set();
    registered.set(type, handlers);
    if (change.add) {
      handlers.add(handler);
    } else {
      handlers.delete(handler);
    }
  }
  return [...registered.values()].reduce((sum, handlers) => sum + handlers.size, 0);
};
async function settle() {
  await Promise.resolve();
  await reference.updateComplete;
  await Promise.resolve();
}
beforeEach(async () => {
  vi.useFakeTimers();
  routeListeners.clear();
  gatewayListeners.clear();
  activities.length = 0;
  request = vi.fn().mockResolvedValue({ profiles: [] });
  const context = {
    gateway: {
      snapshot: { phase: "connected", client: { request }, hello: {} },
      subscribe: (listener: () => void) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    router: {
      subscribe: (listener: () => void) => {
        routeListeners.add(listener);
        return () => routeListeners.delete(listener);
      },
      getState: () => ({ location: {} }),
    },
    agents: { state: {} },
  };
  const original = activityModule.observePersonActivityData;
  vi.spyOn(activityModule, "observePersonActivityData").mockImplementation((...args) => {
    const actual = original(...args);
    const dispose = vi.spyOn(actual, "dispose");
    activities.push({ dispose });
    return actual;
  });
  providerHost = document.createElement("div");
  const provider = new ContextProvider(providerHost, {
    context: applicationContext,
    initialValue: context as unknown as ApplicationContext,
  });
  retained = document.createElement("div");
  providerHost.append(retained);
  reference = document.createElement("openclaw-person-reference") as typeof reference;
  reference.setAttribute("profile-id", "fixture-profile");
  reference.setAttribute("label", "@Fixture Person");
  retained.append(reference);
  document.body.append(providerHost);
  provider.hostConnected();
  await settle();
  button = reference.querySelector("button")!;
  expect(button).not.toBeNull();
  expect(gatewayListeners.size).toBe(1);
  add = vi.spyOn(document, "addEventListener");
  remove = vi.spyOn(document, "removeEventListener");
});
afterEach(() => {
  providerHost.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("real PersonReference delayed hover presentation ownership", () => {
  it.each(["hidden", "inert", "aria-hidden"])(
    "does not acquire resources after ancestor gains %s during delay",
    async (attribute) => {
      hover();
      await vi.advanceTimersByTimeAsync(100);
      retained.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
      await settle();
      await vi.advanceTimersByTimeAsync(250);
      const observed = {
        portal: Boolean(portal()),
        requests: request.mock.calls.length,
        routes: routeListeners.size,
        activities: activities.length,
        disposed: activities.filter((a) => a.dispose.mock.calls.length > 0).length,
        handlers: activeDocumentHandlers(),
      };
      console.log("retired-owner-observation", attribute, JSON.stringify(observed));
      expect(observed).toEqual({
        portal: false,
        requests: 0,
        routes: 0,
        activities: 0,
        disposed: 0,
        handlers: 0,
      });
    },
  );
  it("retirement through the actual retained-pane renderer leaves no hover resources", async () => {
    const container = document.createElement("div");
    providerHost.append(container);
    const options: Parameters<typeof renderChatPagePaneCell>[0] = {
      active: true,
      presented: true,
      chatMessagesBySession: {} as Parameters<
        typeof renderChatPagePaneCell
      >[0]["chatMessagesBySession"],
      sessionSnapshotStore: {} as Parameters<
        typeof renderChatPagePaneCell
      >[0]["sessionSnapshotStore"],
      consumedDraftData: null,
      draftFocus: new RouteDraftComposerFocus(container),
      mergedChrome: false,
      narrow: false,
      navDrawerOpen: false,
      onboarding: false,
      onFaceChange: () => {},
      onFocusPane: () => {},
      onPaneSessionChange: () => false,
      onSessionDeleted: () => {},
      ownerKey: "fixture-owner",
      pane: { id: "fixture-pane", sessionKey: "agent:test:first" },
      panePosition: { column: 1, row: 1 },
      sessionSlots: ["agent:test:first", "agent:test:second"],
      splitMode: false,
      unbound: false,
      weight: 1,
    };
    render(renderChatPagePaneCell(options), container);
    const oldPane = container.querySelector("openclaw-chat-pane")!;
    oldPane.append(reference);
    await settle();
    button = reference.querySelector("button")!;
    expect(oldPane.getAttribute("aria-hidden")).toBe("false");
    expect(oldPane.hasAttribute("inert")).toBe(false);
    hover();
    await vi.advanceTimersByTimeAsync(100);
    // Route listeners are not yet installed by this mention, so dispatching a route
    // change before the renderer update cannot retire its pending hover.
    for (const listener of routeListeners) {
      listener();
    }
    options.pane = { ...options.pane, sessionKey: "agent:test:second" };
    render(renderChatPagePaneCell(options), container);
    await settle();
    expect(container.querySelector("openclaw-chat-pane")).toBe(oldPane);
    expect(reference.isConnected).toBe(true);
    expect(oldPane.getAttribute("aria-hidden")).toBe("true");
    expect(oldPane.hasAttribute("inert")).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    const observed = {
      portal: Boolean(portal()),
      requests: request.mock.calls.length,
      routes: routeListeners.size,
      activities: activities.length,
      handlers: activeDocumentHandlers(),
    };
    console.log("real-retained-renderer", JSON.stringify(observed));
    expect(observed).toEqual({ portal: false, requests: 0, routes: 0, activities: 0, handlers: 0 });
  });
  it("hidden rejection followed by reveal/open/close does not leave an earlier observer", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(100);
    retained.setAttribute("inert", "");
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    retained.removeAttribute("inert");
    await settle();
    hover();
    await vi.advanceTimersByTimeAsync(250);
    expect(portal()).not.toBeNull();
    button.dispatchEvent(new PointerEvent("pointercancel"));
    await settle();
    const observed = {
      requests: request.mock.calls.length,
      routes: routeListeners.size,
      undisposed: activities.filter((a) => a.dispose.mock.calls.length === 0).length,
      handlers: activeDocumentHandlers(),
    };
    console.log("reveal-cleanup", JSON.stringify(observed));
    expect(observed).toEqual({ requests: 1, routes: 0, undisposed: 0, handlers: 0 });
  });
  it("repeated retirement and reveal cycles do not accumulate resources", async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      hover();
      await vi.advanceTimersByTimeAsync(100);
      retained.setAttribute("aria-hidden", "true");
      await settle();
      await vi.advanceTimersByTimeAsync(250);
      retained.removeAttribute("aria-hidden");
      await settle();
      hover();
      await vi.advanceTimersByTimeAsync(250);
      button.dispatchEvent(new PointerEvent("pointercancel"));
      await settle();
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(routeListeners.size).toBe(0);
    expect(activities.filter((a) => a.dispose.mock.calls.length === 0)).toHaveLength(0);
    expect(activeDocumentHandlers()).toBe(0);
  });
  it("a second mention opens normally after the first retires and neither owns the other afterward", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(100);
    retained.setAttribute("inert", "");
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    const second = document.createElement("openclaw-person-reference");
    second.setAttribute("profile-id", "fixture-second");
    second.setAttribute("label", "@Second");
    providerHost.append(second);
    await second.updateComplete;
    const secondButton = second.querySelector("button")!;
    secondButton.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await vi.advanceTimersByTimeAsync(250);
    expect(portal()).not.toBeNull();
    expect(secondButton.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    secondButton.dispatchEvent(new PointerEvent("pointercancel"));
    await settle();
    retained.removeAttribute("inert");
    hover();
    await vi.advanceTimersByTimeAsync(250);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(secondButton.getAttribute("aria-expanded")).toBe("false");
    button.dispatchEvent(new PointerEvent("pointercancel"));
    expect(routeListeners.size).toBe(0);
    expect(activities.filter((a) => a.dispose.mock.calls.length === 0)).toHaveLength(0);
  });
  it("touch pointer entry does not open a hovercard", async () => {
    button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();
    expect(portal()).toBeNull();
    expect(routeListeners.size).toBe(0);
  });
  it("route change after successful open releases subscriptions", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(250);
    for (const listener of routeListeners) {
      listener();
    }
    await settle();
    expect(portal()).toBeNull();
    expect(routeListeners.size).toBe(0);
    const activity = activities[0];
    if (!activity) {
      throw new Error("Expected the successful hover to acquire an activity observer");
    }
    expect(activity.dispose).toHaveBeenCalledTimes(1);
    expect(activeDocumentHandlers()).toBe(0);
  });
  it("profile replacement cancels a pending hover", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(100);
    reference.setAttribute("profile-id", "new-fixture-profile");
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(request).not.toHaveBeenCalled();
    expect(portal()).toBeNull();
    expect(routeListeners.size).toBe(0);
  });
  it("opens while visible and releases on pointercancel", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(250);
    expect(portal()).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(routeListeners.size).toBe(1);
    expect(activities).toHaveLength(1);
    expect(activeDocumentHandlers()).toBe(3);
    button.dispatchEvent(new PointerEvent("pointercancel"));
    await settle();
    expect(portal()).toBeNull();
    expect(routeListeners.size).toBe(0);
    const activity = activities[0];
    if (!activity) {
      throw new Error("Expected the successful hover to acquire an activity observer");
    }
    expect(activity.dispose).toHaveBeenCalledTimes(1);
    expect(activeDocumentHandlers()).toBe(0);
  });
  it("cancels on pointerleave before the delay", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(100);
    button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await vi.advanceTimersByTimeAsync(250);
    expect(request).not.toHaveBeenCalled();
    expect(routeListeners.size).toBe(0);
    expect(activities).toHaveLength(0);
    expect(portal()).toBeNull();
  });
  it("cancels on disconnect before the delay and works after reconnect", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(100);
    reference.remove();
    await vi.advanceTimersByTimeAsync(250);
    expect(request).not.toHaveBeenCalled();
    expect(gatewayListeners.size).toBe(0);
    expect(routeListeners.size).toBe(0);
    retained.append(reference);
    await settle();
    button = reference.querySelector("button")!;
    hover();
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(1);
    expect(portal()).not.toBeNull();
  });
  it("retires an already mounted card when retained ancestor is hidden", async () => {
    hover();
    await vi.advanceTimersByTimeAsync(250);
    retained.setAttribute("inert", "");
    await settle();
    expect(portal()).toBeNull();
    expect(routeListeners.size).toBe(0);
    const activity = activities[0];
    if (!activity) {
      throw new Error("Expected the successful hover to acquire an activity observer");
    }
    expect(activity.dispose).toHaveBeenCalledTimes(1);
    expect(activeDocumentHandlers()).toBe(0);
  });
});
