import {
  createRouter,
  definePage,
  type RouteLocation,
  type RouteMatch,
  type Router,
} from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { SolidRouteProps } from "../app-route-types.tsx";
import { registerMcpAppUnmountTarget } from "../components/mcp-app-unmount.ts";
import {
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import type { ChatRouteData } from "../pages/chat/route-loader.ts";
import { pages as chatPages } from "../pages/chat/route.ts";
import {
  disposeRouterOutlets,
  mountRouterOutlet,
  settleRouterOutlet,
  type MountedRouterOutlet,
} from "./router-outlet.test-support.tsx";

// mock-isolation: Supply the renderer while retaining the registered route's ownership policy.
vi.mock("../pages/chat/chat-page.tsx", () => ({}));

type RouteId = "chat" | "dashboard" | "home" | "settings" | "new-session";
type TestContext = Record<string, never>;
type OwnerMatch = Pick<RouteMatch<string, unknown, ChatRouteData>, "data" | "location">;
type TestModule = {
  renderSolid: (props: SolidRouteProps<ChatRouteData>) => JSX.Element;
  retainOnNavigate?: boolean;
  renderOwnerKey?: (match: OwnerMatch, settled: OwnerMatch | undefined) => string | undefined;
};
type TestRouter = Router<RouteId, TestContext, TestModule, ChatRouteData>;
type RouterOutletElement = MountedRouterOutlet;

type TestPage = Parameters<typeof definePage<RouteId, TestContext, TestModule, ChatRouteData>>[0];
function page(
  id: RouteId,
  component: TestPage["component"] | TestModule | Promise<TestModule>,
  loader?: TestPage["loader"] | ChatRouteData | Promise<ChatRouteData>,
  loaderDeps?: TestPage["loaderDeps"],
) {
  return definePage<RouteId, TestContext, TestModule, ChatRouteData>({
    id,
    path: id === "new-session" ? "/new" : "/" + id,
    component: typeof component === "function" ? component : () => component,
    loader: typeof loader === "function" || loader === undefined ? loader : () => loader,
    loaderDeps,
  });
}
function testRouter(...routes: TestPage[]) {
  return createRouter<RouteId, TestContext, TestModule, ChatRouteData>({ routes });
}
async function navigate(router: TestRouter, outlet: RouterOutletElement, id: RouteId) {
  await router.navigate(id, {});
  await settleOutlet(outlet);
}
function routeValue(outlet: RouterOutletElement) {
  return outlet.querySelector('[data-testid="route-value"]');
}

function location(pathname: string, search = ""): RouteLocation {
  return { pathname, search, hash: "" };
}

function sessionData(sessionKey: string, face: "chat" | "dashboard"): ChatRouteData {
  return { kind: "session", sessionKey, agentId: "main", face, shortId: "12345678" };
}

function createOutlet(router: TestRouter): RouterOutletElement {
  return mountRouterOutlet({ router, retryContext: {} });
}

async function settleOutlet(outlet: RouterOutletElement): Promise<void> {
  await settleRouterOutlet(outlet);
}

function ownedRenderer(teardown: () => Promise<void>) {
  const OwnedRoute = (props: { value: string; presented: boolean }) => (
    <>
      <mcp-app-view
        ref={(element) => {
          const target = Object.assign(element, {
            restartAfterTeardown: vi.fn(),
            teardown,
          });
          onTestFinished(registerMcpAppUnmountTarget(target));
        }}
      />
      <div data-testid="route-value" data-presented={String(props.presented)}>
        {props.value}
      </div>
      <textarea data-testid="route-draft" />
    </>
  );
  return (props: SolidRouteProps<ChatRouteData>) => (
    <Show when={props.data}>
      <OwnedRoute
        value={props.data?.kind === "session" ? props.data.face : "chooser"}
        presented={props.presented}
      />
    </Show>
  );
}

async function routeModule(
  face: "chat" | "dashboard",
  renderSolid: TestModule["renderSolid"],
): Promise<TestModule> {
  const declared = await chatPages[face === "chat" ? 0 : 1].component();
  return {
    renderOwnerKey: declared.renderOwnerKey,
    retainOnNavigate: declared.retainOnNavigate,
    renderSolid,
  };
}

afterEach(() => {
  disposeRouterOutlets();
  Reflect.deleteProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__");
  document.body.replaceChildren();
});

describe("openclaw-router-outlet chat ownership", () => {
  it.each(["error", "notFound", "unmatched location"] as const)(
    "retains only the active launcher across %s recovery",
    async (failure) => {
      const firstLoad = createDeferredCore<ChatRouteData>();
      const retryLoad = createDeferredCore<ChatRouteData>();
      const Launcher = () => <textarea data-testid="launcher" />;
      const module = await routeModule("chat", (props) => (
        <Show when={props.data}>
          <div data-testid="chat-ready">Chat</div>
        </Show>
      ));
      const loader = vi.fn(() => retryLoad.promise);
      if (failure !== "unmatched location") {
        loader.mockImplementationOnce(() => firstLoad.promise);
      }
      const router = testRouter(
        page("new-session", { renderSolid: () => <Launcher /> }),
        page("chat", module, loader),
      );
      const outlet = createOutlet(router);
      await navigate(router, outlet, "new-session");
      const launcher = outlet.querySelector<HTMLTextAreaElement>('[data-testid="launcher"]')!;
      launcher.value = "Keep the first prompt visible";

      if (failure === "unmatched location") {
        await router.navigateLocation(location("/missing"), {});
      } else {
        const navigation = router.navigate("chat", {});
        await settleOutlet(outlet);
        expect(outlet.querySelector('[data-testid="launcher"]')).toBe(launcher);
        expect(launcher.isConnected).toBe(true);
        expect(launcher.value).toBe("Keep the first prompt visible");

        const error = Object.assign(new Error("Chat load failed"), { type: failure });
        const rejected = expect(navigation).rejects.toBe(error);
        firstLoad.reject(error);
        await rejected;
      }
      await settleOutlet(outlet);
      expect(launcher.isConnected).toBe(false);

      const retry = router.navigate("chat", {}, { revalidate: true });
      await settleOutlet(outlet);
      expect(outlet.querySelector('[data-testid="launcher"]')).toBeNull();
      retryLoad.resolve(sessionData("agent:main:main", "chat"));
      await retry;
      await settleOutlet(outlet);
      expect(outlet.querySelector('[data-testid="chat-ready"]')?.textContent).toBe("Chat");
      router.stop();
    },
  );
  it("keeps the loaded session connected and inert across Home and Settings, then restores its draft", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const refreshed = createDeferredCore<ChatRouteData>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(sessionData(sessionKey, "chat"))
      .mockImplementation(() => refreshed.promise);
    const router = testRouter(
      page("chat", module, loader),
      ...(["home", "settings"] as const).map((id) =>
        definePage<RouteId, TestContext, TestModule, ChatRouteData>({
          id,
          path: `/${id}`,
          component: () => ({
            renderSolid: () => <div data-testid="ordinary-route">{id}</div>,
          }),
        }),
      ),
    );
    const outlet = createOutlet(router);
    await navigate(router, outlet, "chat");
    const appView = outlet.querySelector("mcp-app-view")!;
    const draft = outlet.querySelector<HTMLTextAreaElement>('[data-testid="route-draft"]')!;
    draft.value = "Keep this unfinished message";

    for (const id of ["home", "settings"] as const) {
      await router.navigate(id, {});
      await settleOutlet(outlet);
      expect(outlet.querySelector('[data-testid="ordinary-route"]')?.textContent).toBe(id);
      expect(appView.isConnected).toBe(true);
      expect(appView.closest("[inert]")).not.toBeNull();
      expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("false");
      expect(teardown).not.toHaveBeenCalled();
    }

    const navigation = router.navigate("chat", {});
    await settleOutlet(outlet);
    expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("true");
    refreshed.resolve(sessionData(sessionKey, "chat"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(outlet.querySelector('[data-testid="route-draft"]')).toBe(draft);
    expect(draft.value).toBe("Keep this unfinished message");
    expect(appView.closest("[inert]")).toBeNull();
    expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("true");
    expect(outlet.querySelector('[data-testid="ordinary-route"]')).toBeNull();
    expect(teardown).not.toHaveBeenCalled();
    router.stop();
  });

  it("keeps a parked session hidden until the requested session resolves", async () => {
    const firstKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const nextKey = "agent:main:dashboard:abcdef12-3456-7890-abcd-ef1234567890";
    const nextData = createDeferredCore<ChatRouteData>();
    const teardown = vi.fn(async () => undefined);
    const render = ownedRenderer(teardown);
    const chatModule = await routeModule("chat", render);
    const dashboardModule = await routeModule("dashboard", render);
    const router = testRouter(
      page("chat", chatModule, () => sessionData(firstKey, "chat")),
      page("home", { renderSolid: () => <div>Home</div> }),
      page("dashboard", dashboardModule, nextData.promise),
    );
    const outlet = createOutlet(router);
    await navigate(router, outlet, "chat");
    const appView = outlet.querySelector("mcp-app-view")!;
    await navigate(router, outlet, "home");

    const navigation = router.navigate("dashboard", {});
    await settleOutlet(outlet);
    expect(appView.isConnected).toBe(true);
    expect(appView.closest("[inert]")).not.toBeNull();
    expect(outlet.querySelector('[data-testid="route-value"][data-presented="true"]')).toBeNull();
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(sessionData(nextKey, "dashboard"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(appView.closest("[inert]")).toBeNull();
    expect(routeValue(outlet)?.textContent).toBe("dashboard");
    router.stop();
  });

  it("retires parked views and uses the replacement scope's route data", async () => {
    let scope = { key: 1 };
    const oldKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const newKey = "agent:main:dashboard:abcdef12-3456-7890-abcd-ef1234567890";
    const teardownDone = createDeferredCore();
    const teardown = vi.fn(() => teardownDone.promise);
    const nextData = createDeferredCore<ChatRouteData>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(sessionData(oldKey, "chat"))
      .mockImplementation(() => nextData.promise);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const router = testRouter(
      page("chat", module, loader, () => String(scope.key)),
      page("home", { renderSolid: () => <div>Home</div> }),
    );
    const outlet = createOutlet(router);
    outlet.setInputs({ retentionScope: scope });
    await navigate(router, outlet, "chat");
    const appView = outlet.querySelector("mcp-app-view")!;
    await navigate(router, outlet, "home");

    scope = { key: 2 };
    outlet.setInputs({ retentionScope: scope });
    await settleOutlet(outlet);
    expect(teardown).toHaveBeenCalledOnce();
    expect(appView.isConnected).toBe(true);
    expect(appView.closest("[inert]")).not.toBeNull();
    expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("false");

    const navigation = router.navigate("chat", {});
    await settleOutlet(outlet);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(appView.closest("[inert]")).not.toBeNull();
    nextData.resolve(sessionData(newKey, "chat"));
    await navigation;
    await settleOutlet(outlet);
    expect(appView.isConnected).toBe(true);
    expect(appView.closest("[inert]")).not.toBeNull();
    expect(outlet.presentationSettled).toBe(false);
    let settled = false;
    const settlement = outlet.settlePresentation().then((value) => {
      settled = value;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    teardownDone.resolve(undefined);
    expect(await settlement).toBe(true);
    await settleOutlet(outlet);
    expect(appView.isConnected).toBe(false);
    expect(outlet.querySelector("mcp-app-view")).not.toBeNull();
    expect(outlet.querySelector("mcp-app-view")?.closest("[inert]")).toBeNull();
    expect(outlet.presentationSettled).toBe(true);
    router.stop();
  });

  it("keeps a pending destination and ignores its retired scope's late result", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    let scope = { key: 1 };
    const oldResult = createDeferredCore<ChatRouteData>();
    const newResult = createDeferredCore<ChatRouteData>();
    const loader = vi
      .fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementation(() => newResult.promise);
    const module = await routeModule(
      "dashboard",
      ownedRenderer(async () => undefined),
    );
    const router = testRouter(
      page("dashboard", module, loader, (_context, routeLocation) =>
        JSON.stringify([scope.key, routeLocation.pathname]),
      ),
    );
    const outlet = createOutlet(router);
    outlet.setInputs({ retentionScope: scope });
    const destination = location("/dashboard/main/pending-story-12345678");
    const navigation = router.navigate("dashboard", {}, undefined, destination);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    scope = { key: 2 };
    outlet.setInputs({ retentionScope: scope });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader.mock.calls[1]?.[1].location).toEqual(destination);
    oldResult.resolve(sessionData(sessionKey, "chat"));
    await navigation;
    await settleOutlet(outlet);
    expect(routeValue(outlet)).toBeNull();
    newResult.resolve(sessionData(sessionKey, "dashboard"));
    await vi.waitFor(() => expect(routeValue(outlet)?.textContent).toBe("dashboard"));
    expect(router.getState().location).toEqual(destination);
    router.stop();
  });

  it("does not revive a retired session when cold navigation supersedes its scope refresh", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    let scope = { key: 1 };
    const render = ownedRenderer(async () => undefined);
    const chatModule = await routeModule("chat", render);
    const dashboardModule = createDeferredCore<TestModule>();
    const homeModule = createDeferredCore<TestModule>();
    const router = testRouter(
      page(
        "chat",
        chatModule,
        () => sessionData(sessionKey, "chat"),
        () => String(scope.key),
      ),
      page(
        "dashboard",
        dashboardModule.promise,
        () => sessionData(sessionKey, "dashboard"),
        () => String(scope.key),
      ),
      page("home", homeModule.promise),
    );
    const outlet = createOutlet(router);
    outlet.setInputs({ retentionScope: scope });
    await navigate(router, outlet, "chat");
    const dashboardNavigation = router.navigate("dashboard", {});
    await settleOutlet(outlet);
    scope = { key: 2 };
    outlet.setInputs({ retentionScope: scope });
    await settleOutlet(outlet);
    const homeNavigation = router.navigate("home", {});
    dashboardModule.resolve(await routeModule("dashboard", render));
    await dashboardNavigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector('[data-testid="route-value"][data-presented="true"]')).toBeNull();
    homeModule.resolve({ renderSolid: () => <div data-testid="ordinary-route">Home</div> });
    await homeNavigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector('[data-testid="ordinary-route"]')?.textContent).toBe("Home");
    router.stop();
  });

  it("keeps a returning session inert until its pending MCP teardown completes", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const done = createDeferredCore();
    const teardown = vi.fn(() => done.promise);
    const render = ownedRenderer(teardown);
    const module = await routeModule("chat", render);
    const router = testRouter(
      page("chat", module, () => sessionData(sessionKey, "chat")),
      page(
        "dashboard",
        { ...module, renderSolid: () => <p>Session not found</p> },
        {
          kind: "missing-session",
          face: "dashboard",
          currentSessionHref: "/chat/main",
          sessionsHref: "/sessions",
        },
      ),
    );
    const outlet = createOutlet(router);
    await navigate(router, outlet, "chat");
    const appView = outlet.querySelector("mcp-app-view");
    await navigate(router, outlet, "dashboard");
    expect(teardown).toHaveBeenCalledOnce();
    await navigate(router, outlet, "chat");
    expect(appView?.isConnected).toBe(true);
    expect(appView?.closest("[inert]")).not.toBeNull();
    expect(outlet.querySelector('[data-testid="route-value"][data-presented="true"]')).toBeNull();
    done.resolve(undefined);
    await vi.waitFor(() => expect(appView?.closest("[inert]")).toBeNull());
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(teardown).toHaveBeenCalledOnce();
    router.stop();
  });

  it("retires the old page without reloading a replacement router's current result", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const loader = vi.fn(() => sessionData(sessionKey, "chat"));
    const create = () => testRouter(page("chat", module, loader));
    const first = create();
    const second = create();
    const outlet = createOutlet(first);
    await first.navigate("chat", {});
    await settleOutlet(outlet);
    const appView = outlet.querySelector("mcp-app-view");
    await second.navigate("chat", {});
    outlet.setInputs({ router: second });
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).not.toBe(appView);
    expect(outlet.querySelector("mcp-app-view")).not.toBeNull();
    expect(teardown).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledTimes(2);
    first.stop();
    second.stop();
  });

  it("retains the exact subtree across session and presentation switches", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const nextSessionKey = "agent:main:dashboard:abcdef12-3456-7890-abcd-ef1234567890";
    const row = { key: sessionKey, displayName: "Retained board" };
    const chatTarget = sessionNavigationTarget({
      face: "chat",
      sessionKey,
      fallbackAgentId: "main",
      row,
    });
    const dashboardTarget = sessionNavigationTarget({
      face: "dashboard",
      sessionKey: nextSessionKey,
      fallbackAgentId: "main",
      row: { key: nextSessionKey, displayName: "Next retained board" },
    });
    const nextData = createDeferredCore<ChatRouteData>();
    const teardown = vi.fn(async () => undefined);
    const render = ownedRenderer(teardown);
    const chatModule = await routeModule("chat", render);
    const dashboardModule = await routeModule("dashboard", render);
    const router = testRouter(
      page("chat", chatModule, () => sessionData(sessionKey, "chat")),
      page("dashboard", dashboardModule, nextData.promise),
    );
    const outlet = createOutlet(router);
    await router.navigate("chat", {}, undefined, location(chatTarget.href));
    await settleOutlet(outlet);
    const appView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate(
      "dashboard",
      {},
      undefined,
      location(dashboardTarget.options.pathname, dashboardTarget.options.search),
    );
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(routeValue(outlet)?.textContent).toBe("chat");
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(sessionData(nextSessionKey, "dashboard"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(routeValue(outlet)?.textContent).toBe("dashboard");
    expect(teardown).not.toHaveBeenCalled();
    router.stop();
  });

  it("retains a full-key-hinted route while it cleans up to its recorded canonical location", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const clean = location("/chat/main/deploy-monitor-12345678");
    const hintedSearch = new URLSearchParams({
      [SESSION_NAVIGATION_KEY_PARAM]: sessionKey,
      draft: "ship it",
      [SESSION_COMPOSER_FOCUS_PARAM]: "1",
    });
    const hinted = location("/chat/main/wrong-name-12345678", `?${hintedSearch.toString()}`);
    const canonical = location(
      clean.pathname,
      `?${new URLSearchParams({ draft: "ship it", [SESSION_COMPOSER_FOCUS_PARAM]: "1" })}`,
    );
    const initial = { ...sessionData(sessionKey, "chat"), canonicalLocation: canonical };
    const nextData = createDeferredCore<ChatRouteData>();
    let loadCount = 0;
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const router = testRouter(
      page(
        "chat",
        module,
        () => (++loadCount === 1 ? initial : nextData.promise),
        (_context, routeLocation) => `${routeLocation.pathname}${routeLocation.search}`,
      ),
    );
    const outlet = createOutlet(router);
    await router.navigate("chat", {}, undefined, hinted);
    await settleOutlet(outlet);
    const appView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate("chat", {}, undefined, clean);
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(sessionData(sessionKey, "chat"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(teardown).not.toHaveBeenCalled();
    router.stop();
  });

  it("retains the chat page when a colliding short path's full-key hint changes", async () => {
    const firstKey = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
    const secondKey = "agent:main:dashboard:12345678-0bbb-4000-8000-000000000002";
    const pathname = "/chat/main/deploy-monitor-12345678";
    const nextData = createDeferredCore<ChatRouteData>();
    let loadCount = 0;
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const router = createRouter<RouteId, TestContext, TestModule, ChatRouteData>({
      routes: [
        definePage({
          id: "chat",
          path: "/chat",
          component: () => module,
          loaderDeps: (_context, routeLocation) => routeLocation.search,
          loader: () => (++loadCount === 1 ? sessionData(firstKey, "chat") : nextData.promise),
        }),
      ],
    });
    const outlet = createOutlet(router);
    await router.navigate(
      "chat",
      {},
      undefined,
      location(pathname, `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(firstKey)}`),
    );
    await settleOutlet(outlet);
    const firstView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate(
      "chat",
      {},
      undefined,
      location(pathname, `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(secondKey)}`),
    );
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(firstView);
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(sessionData(secondKey, "chat"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(firstView);
    expect(teardown).not.toHaveBeenCalled();
    router.stop();
  });

  it.each([
    {
      label: "an ambiguous result",
      result: {
        kind: "ambiguous",
        shortId: "12345678",
        candidates: [],
        truncated: false,
        face: "chat",
      } satisfies ChatRouteData,
    },
    {
      label: "a missing-session result",
      result: {
        kind: "missing-session",
        face: "chat",
        currentSessionHref: "/chat/main",
        sessionsHref: "/sessions",
      } satisfies ChatRouteData,
    },
  ])("retains an unresolved route until $label replaces it", async ({ result }) => {
    const sessionKey = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
    const nextData = createDeferredCore<ChatRouteData>();
    let loadCount = 0;
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const router = testRouter(
      page(
        "chat",
        module,
        () => (++loadCount === 1 ? sessionData(sessionKey, "chat") : nextData.promise),
        (_context, routeLocation) => routeLocation.pathname,
      ),
    );
    const outlet = createOutlet(router);
    await router.navigate("chat", {}, undefined, location("/chat/main/alpha-12345678"));
    await settleOutlet(outlet);
    const firstView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate("chat", {}, undefined, location("/chat/main/beta-12345678"));
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(firstView);
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(result);
    await navigation;
    await settleOutlet(outlet);
    expect(routeValue(outlet)?.textContent).toBe("chooser");
    expect(teardown).toHaveBeenCalledOnce();
    router.stop();
  });
});
