import { createRouter, definePage } from "@openclaw/uirouter";
import { action } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { mountRouterOutlet, settleRouterOutlet } from "./router-outlet.test-support.tsx";

const exception = "Cannot read properties of undefined (reading 'kind')";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The page throws from its body while `failing` holds, as a real render failure does. */
function throwingRouter(options: { retainOnNavigate?: boolean; sharedOwner?: boolean } = {}) {
  const state = { failing: true };
  const FailingPage = () => {
    if (state.failing) {
      throw new TypeError(exception);
    }
    return <p>Page content</p>;
  };
  const module = {
    renderSolid: () => <FailingPage />,
    ...(options.sharedOwner ? { renderOwnerKey: () => "shared-owner" } : {}),
    ...(options.retainOnNavigate
      ? { renderOwnerKey: () => "retained-owner", retainOnNavigate: true }
      : {}),
  };
  const router = createRouter({
    routes: [
      definePage({ id: "page", path: "/page", component: () => module }),
      definePage({
        id: "twin",
        path: "/twin",
        component: () => module,
      }),
      definePage({
        id: "next",
        path: "/next",
        component: () => ({ renderSolid: () => <p>Current destination</p> }),
      }),
    ],
  });
  return { router, state };
}

it("keeps a page's render failure in the outlet without its exception text, then retries", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const context = { label: "page" };
  const { router, state } = throwingRouter();
  document.documentElement.setAttribute("data-openclaw-warm-frame", "holding");
  const outlet = mountRouterOutlet({ router, retryContext: context });
  try {
    await router.navigate("page", context);
    await settleRouterOutlet(outlet);

    const alert = outlet.querySelector('[role="alert"]');
    expect(document.documentElement.hasAttribute("data-openclaw-warm-frame")).toBe(false);
    expect(alert?.textContent).toContain("Couldn’t load this panel.");
    expect(outlet.textContent).not.toContain(exception);
    expect(outlet.querySelector("details")).toBeNull();
    expect(logged).toHaveBeenCalledWith("[openclaw] route render failed", expect.any(TypeError));

    alert?.querySelector("button")?.click();
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[role="alert"]')).not.toBeNull();

    state.failing = false;
    outlet.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    await expect.poll(() => outlet.textContent).toContain("Page content");
    expect(outlet.querySelector('[role="alert"]')).toBeNull();
  } finally {
    document.documentElement.removeAttribute("data-openclaw-warm-frame");
    outlet.dispose();
    router.stop();
  }
});

it("clears a render failure when navigating to another page", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const context = { label: "page" };
  const { router } = throwingRouter();
  const outlet = mountRouterOutlet({ router, retryContext: context });
  try {
    await router.navigate("page", context);
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[role="alert"]')).not.toBeNull();

    await router.navigate("next", context);
    await settleRouterOutlet(outlet);
    expect(outlet.textContent).toContain("Current destination");
    expect(outlet.querySelector('[role="alert"]')).toBeNull();
  } finally {
    outlet.dispose();
    router.stop();
  }
});

it("retries a failed page shared by the destination route, as Settings subpages share one", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const context = { label: "page" };
  const { router, state } = throwingRouter({ sharedOwner: true });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  try {
    await router.navigate("page", context);
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[role="alert"]')).not.toBeNull();

    state.failing = false;
    await router.navigate("twin", context);
    await expect.poll(() => outlet.textContent).toContain("Page content");
    expect(outlet.querySelector('[role="alert"]')).toBeNull();
  } finally {
    outlet.dispose();
    router.stop();
  }
});

it("does not park a retained page's render failure behind the current destination", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const context = { label: "page" };
  const { router, state } = throwingRouter({ retainOnNavigate: true });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  try {
    await router.navigate("page", context);
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[role="alert"]')).not.toBeNull();

    state.failing = false;
    await router.navigate("next", context);
    await settleRouterOutlet(outlet);
    expect(outlet.textContent).toContain("Current destination");

    await router.navigate("page", context);
    await expect.poll(() => outlet.textContent).toContain("Page content");
    expect(outlet.querySelector('[role="alert"]')).toBeNull();
  } finally {
    outlet.dispose();
    router.stop();
  }
});

it("lets browser tasks complete while waiting for a route presentation commit", async () => {
  const context = { label: "page" };
  const router = createRouter({
    routes: [
      definePage({
        id: "page",
        path: "/page",
        component: () => ({ renderSolid: () => <p>Previous destination</p> }),
      }),
      definePage({
        id: "next",
        path: "/next",
        component: () => ({ renderSolid: () => <p>Current destination</p> }),
      }),
    ],
  });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  const completion = createDeferredCore();
  const channel = new MessageChannel();
  try {
    await router.navigate("page", context);
    await settleRouterOutlet(outlet);
    const navigation = action(function* () {
      const pending = router.navigate("next", context);
      yield completion.promise;
      yield pending;
    })();
    const settlement = outlet.settlePresentation();
    channel.port1.addEventListener("message", () => completion.resolve(), { once: true });
    channel.port1.start();
    channel.port2.postMessage(null);

    await navigation;
    await expect(settlement).resolves.toBe(true);
    expect(outlet.textContent).toContain("Current destination");
    expect(outlet.textContent).not.toContain("Previous destination");
  } finally {
    completion.resolve();
    channel.port1.close();
    channel.port2.close();
    outlet.dispose();
    router.stop();
  }
});
