import { describe, expect, it, vi } from "vitest";
import { createRouter, definePage, type RouteHookOptions, type RouterHistory } from "./index.ts";

type LoadCall = {
  context: string;
  options: RouteHookOptions;
  resolve: (value: string) => void;
};

function createHistory(): RouterHistory {
  return {
    location: () => ({ pathname: "/page", search: "?source=initial", hash: "" }),
    push: vi.fn(),
    replace: vi.fn(),
    listen: vi.fn(() => vi.fn()),
  };
}

describe("router revalidation", () => {
  it("restarts a pending route load with the latest context", async () => {
    const calls: LoadCall[] = [];
    let resolveComponent: (module: { render: () => undefined }) => void = () => undefined;
    const component = new Promise<{ render: () => undefined }>((resolve) => {
      resolveComponent = resolve;
    });
    const page = definePage({
      id: "page",
      path: "/page",
      component: () => component,
      loader: (context: string, options: RouteHookOptions) =>
        new Promise<string>((resolve) => calls.push({ context, options, resolve })),
    });
    const router = createRouter({ routes: [page] });

    const initialLoad = router.start(createHistory(), "", "disconnected");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const connectedLoad = router.revalidate("connected");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]?.options.signal.aborted).toBe(true);
    expect(calls[1]?.context).toBe("connected");
    expect(calls[1]?.options.location.search).toBe("?source=initial");

    resolveComponent({ render: () => undefined });
    calls[1]?.resolve("fresh");
    await connectedLoad;
    calls[0]?.resolve("stale");
    await initialLoad;

    expect(router.getState().matches[0]?.data).toBe("fresh");
  });

  it("restarts an aborted load when navigating back to the same route", async () => {
    const calls: LoadCall[] = [];
    const page = definePage({
      id: "page",
      path: "/page",
      component: async () => ({ render: () => undefined }),
      loader: (context: string, options: RouteHookOptions) =>
        new Promise<string>((resolve) => calls.push({ context, options, resolve })),
    });
    const other = definePage({
      id: "other",
      path: "/other",
      component: async () => ({ render: () => undefined }),
      loader: async () => "other",
    });
    const router = createRouter({ routes: [page, other] });

    const initialLoad = router.start(createHistory(), "", "initial");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await router.navigateLocation({ pathname: "/other", search: "", hash: "" }, "other-context");

    const returnLoad = router.navigateLocation(
      { pathname: "/page", search: "?source=return", hash: "" },
      "return-context",
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]?.options.signal.aborted).toBe(true);
    expect(calls[1]?.options.signal.aborted).toBe(false);

    calls[1]?.resolve("fresh");
    await returnLoad;
    calls[0]?.resolve("stale");
    await initialLoad;

    const active = router.getState().matches[0];
    expect(active?.routeId).toBe("page");
    expect(active?.data).toBe("fresh");
    expect(active?.module).toBeDefined();
  });
});
