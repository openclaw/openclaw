/* @vitest-environment jsdom */
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createRouter, definePage, type RouteLocation } from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { SolidRouteProps } from "../app-route-types.ts";
import {
  disposeRouterOutlets,
  mountRouterOutlet,
  settleRouterOutlet,
} from "./router-outlet.test-support.tsx";

type RouteId = "first" | "second";
type TestContext = { label: string };
type TestModule = { renderSolid: (props: SolidRouteProps<TestData>) => JSX.Element };
type TestData = { label: string };

function location(pathname: string): RouteLocation {
  return { pathname, search: "", hash: "" };
}
function module(label: string): TestModule {
  return {
    renderSolid: (props) => <section data-route={label}>{props.data?.label ?? "pending"}</section>,
  };
}
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  disposeRouterOutlets();
  vi.useRealTimers();
});

describe("router outlet pending presentation", () => {
  it("keeps the previous page through a cold navigation and updates the loaded destination", async () => {
    vi.useFakeTimers();
    const secondModule = createDeferredCore<TestModule>();
    const secondData = createDeferredCore<TestData>();
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => module("first"),
          loader: () => ({ label: "first" }),
        }),
        definePage({
          id: "second",
          path: "/second",
          component: () => secondModule.promise,
          loader: () => secondData.promise,
        }),
      ],
    });
    onTestFinished(() => router.stop());
    const outlet = mountRouterOutlet({ router });
    await router.navigate("first", { label: "test" });
    await settleRouterOutlet(outlet);
    const firstPage = outlet.querySelector('[data-route="first"]');
    const navigation = router.navigate("second", { label: "test" });
    expect(outlet.presentationSettled).toBe(false);
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[data-route="first"]')).toBe(firstPage);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outlet.querySelector('[role="status"]')).toBeNull();
    secondModule.resolve(module("second"));
    await flushPromises();
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[data-route="second"]')?.textContent).toBe("pending");
    secondData.resolve({ label: "second" });
    await navigation;
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[data-route="second"]')?.textContent).toBe("second");
    const replacement = createRouter<RouteId, TestContext, TestModule, TestData>({ routes: [] });
    onTestFinished(() => replacement.stop());
    outlet.setInputs({ router: replacement });
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector("section")).toBeNull();
  });

  it("cancels the pending delay on disposal and starts a full delay for a new owner", async () => {
    vi.useFakeTimers();
    const routeModule = createDeferredCore<TestModule>();
    const routeData = createDeferredCore<TestData>();
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => routeModule.promise,
          loader: () => routeData.promise,
        }),
      ],
    });
    onTestFinished(() => router.stop());
    let outlet = mountRouterOutlet({ router });
    const navigation = router.navigate("first", { label: "test" });
    await vi.advanceTimersByTimeAsync(500);
    outlet.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    outlet = mountRouterOutlet({ router });
    await vi.advanceTimersByTimeAsync(999);
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[role="status"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[role="status"]')).not.toBeNull();
    routeModule.resolve(module("first"));
    routeData.resolve({ label: "loaded" });
    await navigation;
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[data-route="first"]')?.textContent).toBe("loaded");
    expect(outlet.querySelector('[role="status"]')).toBeNull();
  });
});

describe("router outlet not-found recovery", () => {
  function createTestRouter() {
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => module("first"),
          loader: () => ({ label: "first" }),
        }),
      ],
    });
    onTestFinished(() => router.stop());
    return router;
  }

  it("notifies once for an unmatched location", async () => {
    const router = createTestRouter();
    const onNotFound = vi.fn();
    const outlet = mountRouterOutlet({ router, onNotFound });
    await router.navigateLocation(location("/missing"), { label: "test" });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(1);
    outlet.setInputs({ onNotFound });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(1);
  });

  it("suppresses queued recovery after a new navigation", async () => {
    const router = createTestRouter();
    const onNotFound = vi.fn();
    const outlet = mountRouterOutlet({ router, onNotFound });
    const missing = router.navigateLocation(location("/missing"), { label: "test" });
    const recovery = router.navigate("first", { label: "test" });
    await Promise.all([missing, recovery]);
    await settleRouterOutlet(outlet);
    expect(onNotFound).not.toHaveBeenCalled();
    expect(outlet.querySelector('[data-route="first"]')?.textContent).toBe("first");
  });

  it("settles a replacement source with the same not-found presentation", async () => {
    const first = createTestRouter();
    const second = createTestRouter();
    await first.navigateLocation(location("/missing"), { label: "test" });
    await second.navigateLocation(location("/missing"), { label: "test" });
    const onNotFound = vi.fn();
    const outlet = mountRouterOutlet({ router: first, onNotFound });
    await settleRouterOutlet(outlet);
    expect(outlet.presentationSettled).toBe(true);
    outlet.setInputs({ router: second });
    await settleRouterOutlet(outlet);
    expect(outlet.presentationSettled).toBe(true);
    expect(onNotFound).toHaveBeenCalledTimes(2);
  });

  it("preserves navigation started by an earlier not-found subscriber", async () => {
    const secondModule = createDeferredCore<TestModule>();
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => module("first"),
          loader: (): TestData => {
            throw Object.assign(new Error("Initial route not found"), { type: "notFound" });
          },
        }),
        definePage({
          id: "second",
          path: "/second",
          component: () => secondModule.promise,
          loader: () => ({ label: "second" }),
        }),
      ],
    });
    onTestFinished(() => router.stop());
    let recovery: Promise<void> | undefined;
    let redirected = false;
    const unsubscribe = router.subscribe((state) => {
      if (state.status === "notFound" && !redirected) {
        redirected = true;
        recovery = router.navigate("second", { label: "test" });
      }
    });
    onTestFinished(() => {
      unsubscribe();
    });
    const onNotFound = vi.fn();
    const outlet = mountRouterOutlet({ router, onNotFound });
    try {
      await expect(router.navigate("first", { label: "test" })).rejects.toMatchObject({
        type: "notFound",
      });
      await flushPromises();
      expect(router.getState().status).toBe("loading");
      expect(onNotFound).not.toHaveBeenCalled();
    } finally {
      secondModule.resolve(module("second"));
      await recovery;
    }
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector('[data-route="second"]')?.textContent).toBe("second");
  });

  it("cancels queued recovery on disposal and evaluates it for the next owner", async () => {
    const router = createTestRouter();
    const onNotFound = vi.fn();
    let outlet = mountRouterOutlet({ router, onNotFound });
    const missing = router.navigateLocation(location("/missing"), { label: "test" });
    outlet.dispose();
    await missing;
    await flushPromises();
    expect(onNotFound).not.toHaveBeenCalled();
    outlet = mountRouterOutlet({ router, onNotFound });
    await settleRouterOutlet(outlet);
    expect(onNotFound).toHaveBeenCalledTimes(1);
  });

  it("retries a declined recovery once readiness changes", async () => {
    const router = createTestRouter();
    const onNotFound = vi.fn(() => false);
    const outlet = mountRouterOutlet({ router, onNotFound, notFoundRecoveryReady: false });
    await router.navigateLocation(location("/missing"), { label: "test" });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(1);
    outlet.setInputs({ notFoundRecoveryReady: false });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(1);
    outlet.setInputs({ notFoundRecoveryReady: true });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(2);
    outlet.setInputs({ notFoundRecoveryReady: true });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(2);
  });
});

describe("router outlet agent startup", () => {
  it.each(["navigation", "disconnect", "offline", "context"] as const)(
    "retires startup retries on %s without reviving the old route",
    async (boundary) => {
      vi.useFakeTimers();
      const read = vi.fn((): TestData => {
        throw new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Preparing",
          retryable: true,
          retryAfterMs: 250,
          details: { code: "agent-database-inspection-pending" },
        });
      });
      const router = createRouter<RouteId, TestContext, TestModule, TestData>({
        routes: [
          definePage({
            id: "first",
            path: "/first",
            component: () => module("first"),
            loader: read,
          }),
          definePage({
            id: "second",
            path: "/second",
            component: () => module("second"),
            loader: () => ({ label: "ready" }),
          }),
        ],
      });
      onTestFinished(() => router.stop());
      const retryContext = { label: "test" };
      const outlet = mountRouterOutlet({ router, retryContext });
      await router.navigate("first", retryContext).catch(() => undefined);
      await settleRouterOutlet(outlet);
      expect(outlet.querySelector(".agent-startup-state")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(499);
      expect(read).toHaveBeenCalledTimes(1);
      if (boundary === "navigation") {
        await router.navigate("second", retryContext);
      } else if (boundary === "disconnect") {
        outlet.dispose();
      } else if (boundary === "offline") {
        outlet.setInputs({ retryEnabled: false });
      } else {
        outlet.setInputs({ retryContext: undefined });
      }
      await vi.advanceTimersByTimeAsync(180_000);
      expect(read).toHaveBeenCalledTimes(1);
      if (boundary === "navigation") {
        await settleRouterOutlet(outlet);
        expect(outlet.querySelector('[data-route="second"]')?.textContent).toBe("ready");
      }
    },
  );
});
