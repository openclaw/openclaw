/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { createApplicationRouter, startApplicationRouter } from "../app-routes.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { ShellNavigationOwner, type ShellNavigationHost } from "./app-shell-navigation.ts";
import { normalizeInitialApplicationLocation } from "./bootstrap-location.ts";
import type { ApplicationContext } from "./context.ts";
import { mountRouterOutlet, settleRouterOutlet } from "./router-outlet.test-support.tsx";

it.each(["/beam/unfinished-share-5", "/settings/unknown/page"])(
  "keeps the requested %s visible instead of restoring an unrelated saved session",
  async (pathname) => {
    const requested = { pathname: `/control${pathname}`, search: "?from=link", hash: "#message" };
    const savedKey = "agent:research:dashboard:11111111-2222-4333-8444-555555555555";
    const replace = vi.fn();
    // The transport is not needed for an unmatched route. Keep its real boot,
    // router, shell recovery, and outlet owners together in the reported order.
    const context = {
      basePath: "/control",
      gateway: {
        snapshot: { phase: "connected", client: {}, hello: {} },
        subscribe: () => () => {},
      },
      replace,
    } as unknown as ApplicationContext;
    let location = normalizeInitialApplicationLocation(
      requested,
      context.basePath,
      savedKey,
      "research",
    );
    expect(location).toEqual(requested);
    let pop: (next: typeof location) => void = () => {};
    const history = {
      location: () => location,
      replace: vi.fn((next: typeof location) => {
        location = next;
      }),
      push: vi.fn(),
      listen: (listener: typeof pop) => {
        pop = listener;
        return () => {};
      },
    };
    const router = createApplicationRouter();
    const host: ShellNavigationHost = {
      context,
      activeSessionKey: savedKey,
      routeState: {},
      lastWorkspaceLocation: null,
      custodianMinimizeRequestId: 0,
      lastConcreteRouteId: undefined,
      didConsiderNativeRouteRestore: false,
      settingsSearchQuery: "",
      closeNavDrawer: vi.fn(),
      ensureAgentsList: vi.fn(),
    };
    const navigation = new ShellNavigationOwner(host);
    const stop = router.subscribe((state) => {
      host.routeState = selectShellRouteState(state);
    });
    const outlet = mountRouterOutlet({
      router,
      retryContext: context,
      onNotFound: () => navigation.recoverNotFoundRoute(),
      notFoundRecoveryReady: false,
    });
    onTestFinished(() => {
      outlet.dispose();
      stop();
      router.stop();
    });

    await startApplicationRouter(router, history, context.basePath, context);
    await settleRouterOutlet(outlet);
    expect(router.getState().status).toBe("notFound");
    expect(history.location()).toEqual(requested);
    expect(host.routeState.location).toEqual(requested);
    expect(outlet.textContent).toContain("Page not found");
    expect(outlet.querySelector<HTMLAnchorElement>('a[href="/control/chat"]')?.textContent).toBe(
      "Go to chat",
    );
    expect(replace).not.toHaveBeenCalled();
    expect(host.activeSessionKey).toBe(savedKey);

    const next = { ...requested, pathname: "/control/beam/another-unfinished-share-6" };
    location = next;
    pop(next);
    await settleRouterOutlet(outlet);
    expect(router.getState().location).toEqual(next);
    expect(outlet.textContent).toContain("Page not found");
    expect(replace).not.toHaveBeenCalled();
  },
);
