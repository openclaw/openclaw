import { createRouter } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { RouteId } from "../app-routes.ts";
import { CHAT_ROUTE_READY_EVENT } from "../pages/chat/chat-history-events.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { navigateWithRouteTransition } from "./route-transition.ts";

const location = (pathname: string, search = "") => ({ pathname, search, hash: "" });

function testDocumentWithOutlet(animate = vi.fn()) {
  const router = createRouter<RouteId>({
    routes: [
      { id: "chat", path: "/chat", component: () => ({}) },
      { id: "about", path: "/about", component: () => ({}) },
    ],
  });
  void router.navigate("chat", undefined);
  const outlet = Object.assign(document.createElement("openclaw-router-outlet"), {
    presentationSettled: true,
    settlePresentation: async () => true,
  }) satisfies ControlUiReadinessOutlet;
  outlet.animate = animate;
  document.body.append(outlet);
  return {
    animate,
    document,
    outlet,
    router,
    transition: (
      navigate: () => Promise<void>,
      options: Partial<Parameters<typeof navigateWithRouteTransition>[0]> = {},
    ) =>
      navigateWithRouteTransition({
        document,
        getOutlet: () => outlet,
        router,
        from: "new-session",
        to: "chat",
        navigate,
        prefersReducedMotion: false,
        ...options,
      }),
  };
}

afterEach(() => document.body.replaceChildren());

it("animates the rendered chat pane without freezing the outgoing document", async () => {
  const finished = Promise.resolve({} as Animation);
  const animate = vi.fn(() => ({ finished }) as Animation);
  const test = testDocumentWithOutlet(animate);
  const navigation = createDeferredCore();
  const navigate = vi.fn(() => navigation.promise);

  const transition = test.transition(navigate);
  expect(navigate).toHaveBeenCalledOnce();
  expect(animate).not.toHaveBeenCalled();
  navigation.resolve();
  document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
  await transition;

  expect(navigate).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenCalledWith(
    [{ transform: "translateY(5px) scale(0.997)" }, { transform: "none" }],
    { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  );
});

it("propagates navigation failure without animating", async () => {
  const test = testDocumentWithOutlet();
  const failure = new Error("Chat route failed to load");
  const navigate = vi.fn(async () => {
    throw failure;
  });

  await expect(test.transition(navigate)).rejects.toBe(failure);

  expect(navigate).toHaveBeenCalledOnce();
  expect(test.animate).not.toHaveBeenCalled();
});

it.each([
  { from: "about" as const, to: "chat" as const, prefersReducedMotion: false },
  { from: "new-session" as const, to: "about" as const, prefersReducedMotion: false },
])("navigates directly for $from to $to", async ({ from, to, prefersReducedMotion }) => {
  const test = testDocumentWithOutlet();
  const navigate = vi.fn(async () => undefined);

  await test.transition(navigate, { from, to, prefersReducedMotion });

  expect(navigate).toHaveBeenCalledOnce();
  expect(test.animate).not.toHaveBeenCalled();
});

it("cancels a running entrance when another route takes over", async () => {
  const cancel = vi.fn();
  const running: Partial<Animation> = { finished: new Promise(() => {}), cancel };
  const animate = vi.fn(() => running as Animation);
  const test = testDocumentWithOutlet(animate);
  const transition = test.transition(async () => undefined);
  document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
  await vi.waitFor(() => expect(animate).toHaveBeenCalledOnce());

  await test.router.navigate("about", undefined);
  await transition;

  expect(cancel).toHaveBeenCalledOnce();
});

it("waits for the chat route without animating when motion is reduced", async () => {
  const test = testDocumentWithOutlet();
  const navigate = vi.fn(async () => undefined);
  const transition = test.transition(navigate, { prefersReducedMotion: true });

  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
  await transition;

  expect(test.animate).not.toHaveBeenCalled();
});

it("keeps waiting through same-path focus cleanup but retires a different Chat destination", async () => {
  const test = testDocumentWithOutlet();
  await test.router.navigate("chat", undefined);
  const navigation = test.router.navigate(
    "chat",
    undefined,
    {},
    location("/chat/main/first", "?focusComposer=1"),
  );
  const transition = test.transition(() => navigation);
  await navigation;
  let settled = false;
  void transition.then(() => {
    settled = true;
  });
  await test.router.navigate(
    "chat",
    undefined,
    { history: "replace" },
    location("/chat/main/first"),
  );
  expect(settled).toBe(false);
  await test.router.navigate("chat", undefined, {}, location("/chat/main/second"));
  await transition;
  document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
  expect(test.animate).not.toHaveBeenCalled();
});
