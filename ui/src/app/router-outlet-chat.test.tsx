import type { RouteLocation } from "@openclaw/uirouter";
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
import { routeFixtures, type OutletModule } from "./router-outlet-fixtures.test-support.tsx";
import {
  disposeRouterOutlets,
  mountRouterOutlet,
  settleRouterOutlet as settleOutlet,
  type MountedRouterOutlet,
} from "./router-outlet.test-support.tsx";

// mock-isolation: Supply the renderer while retaining the registered route's ownership policy.
vi.mock("../pages/chat/chat-page.tsx", () => ({}));

type RouteId = "chat" | "dashboard" | "home" | "settings" | "new-session";
type TestContext = Record<string, never>;
type TestModule = OutletModule<ChatRouteData>;
const routes = routeFixtures<RouteId, TestContext, ChatRouteData>();
const page = routes.page;
const testRouter = routes.router;
type TestRouter = ReturnType<typeof testRouter>;
type RouterOutletElement = MountedRouterOutlet;

async function navigate(
  router: TestRouter,
  outlet: RouterOutletElement,
  id: RouteId,
  target?: RouteLocation,
) {
  await router.navigate(id, {}, undefined, target);
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

async function ownedModule(
  face: "chat" | "dashboard" = "chat",
  teardown = vi.fn(async () => undefined),
) {
  return { teardown, module: await routeModule(face, ownedRenderer(teardown)) };
}

function expectRetained(
  outlet: RouterOutletElement,
  view: Element | null,
  teardown: () => Promise<void>,
) {
  expect(outlet.querySelector("mcp-app-view")).toBe(view);
  expect(teardown).not.toHaveBeenCalled();
}

afterEach(() => {
  disposeRouterOutlets();
  routes.dispose();
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
    },
  );
  it("keeps the loaded session connected and inert across Home and Settings, then restores its draft", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const { teardown, module } = await ownedModule();
    const refreshed = createDeferredCore<ChatRouteData>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(sessionData(sessionKey, "chat"))
      .mockImplementation(() => refreshed.promise);
    const router = testRouter(
      page("chat", module, loader),
      ...(["home", "settings"] as const).map((id) =>
        page(id, { renderSolid: () => <div data-testid="ordinary-route">{id}</div> }),
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
  });

  it.each([false, true])(
    "retains the session subtree across presentation switches (parked: %s)",
    async (parked) => {
      const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
      const nextKey = "agent:main:dashboard:abcdef12-3456-7890-abcd-ef1234567890";
      const target = (key: string, face: "chat" | "dashboard") =>
        sessionNavigationTarget({
          face,
          sessionKey: key,
          fallbackAgentId: "main",
          row: { key, displayName: "Retained board" },
        });
      const chatTarget = target(sessionKey, "chat");
      const dashboardTarget = target(nextKey, "dashboard");
      const nextData = createDeferredCore<ChatRouteData>();
      const teardown = vi.fn(async () => undefined);
      const render = ownedRenderer(teardown);
      const router = testRouter(
        page("chat", await routeModule("chat", render), sessionData(sessionKey, "chat")),
        page("dashboard", await routeModule("dashboard", render), nextData.promise),
        page("home", { renderSolid: () => <div>Home</div> }),
      );
      const outlet = createOutlet(router);
      await navigate(router, outlet, "chat", parked ? undefined : location(chatTarget.href));
      const appView = outlet.querySelector("mcp-app-view")!;
      if (parked) {
        await navigate(router, outlet, "home");
      }
      const navigation = router.navigate(
        "dashboard",
        {},
        undefined,
        parked
          ? undefined
          : location(dashboardTarget.options.pathname, dashboardTarget.options.search),
      );
      await settleOutlet(outlet);
      expectRetained(outlet, appView, teardown);
      if (parked) {
        expect(appView.isConnected).toBe(true);
        expect(appView.closest("[inert]")).not.toBeNull();
        expect(
          outlet.querySelector('[data-testid="route-value"][data-presented="true"]'),
        ).toBeNull();
      } else {
        expect(routeValue(outlet)?.textContent).toBe("chat");
      }
      nextData.resolve(sessionData(nextKey, "dashboard"));
      await navigation;
      await settleOutlet(outlet);
      expectRetained(outlet, appView, teardown);
      expect(appView.closest("[inert]")).toBeNull();
      expect(routeValue(outlet)?.textContent).toBe("dashboard");
    },
  );

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
  });

  it("retires the old page without reloading a replacement router's current result", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const { teardown, module } = await ownedModule();
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
  });

  const fullKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
  const firstKey = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
  const collisionKey = "agent:main:dashboard:12345678-0bbb-4000-8000-000000000002";
  const path = "/chat/main/deploy-monitor-12345678";
  const composerSearch = new URLSearchParams({
    draft: "ship it",
    [SESSION_COMPOSER_FOCUS_PARAM]: "1",
  });
  const hinted = (key: string) =>
    location(path, `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(key)}`);
  const unresolved = {
    initialLocation: location("/chat/main/alpha-12345678"),
    destination: location("/chat/main/beta-12345678"),
    initial: sessionData(firstKey, "chat"),
    deps: (routeLocation: RouteLocation) => routeLocation.pathname,
  };

  it.each([
    {
      label: "a full-key hint cleans up to its canonical location",
      initialLocation: location(
        "/chat/main/wrong-name-12345678",
        `?${composerSearch}&${SESSION_NAVIGATION_KEY_PARAM}=${fullKey}`,
      ),
      destination: location(path),
      initial: {
        ...sessionData(fullKey, "chat"),
        canonicalLocation: location(path, `?${composerSearch}`),
      },
      result: sessionData(fullKey, "chat"),
      deps: (routeLocation: RouteLocation) => `${routeLocation.pathname}${routeLocation.search}`,
    },
    {
      label: "a colliding short path's full-key hint changes",
      initialLocation: hinted(firstKey),
      destination: hinted(collisionKey),
      initial: sessionData(firstKey, "chat"),
      result: sessionData(collisionKey, "chat"),
      deps: (routeLocation: RouteLocation) => routeLocation.search,
    },
    {
      ...unresolved,
      label: "an unresolved route becomes ambiguous",
      result: {
        kind: "ambiguous",
        shortId: "12345678",
        candidates: [],
        truncated: false,
        face: "chat",
      } satisfies ChatRouteData,
    },
    {
      ...unresolved,
      label: "an unresolved route becomes missing-session",
      result: {
        kind: "missing-session",
        face: "chat",
        currentSessionHref: "/chat/main",
        sessionsHref: "/sessions",
      } satisfies ChatRouteData,
    },
  ])(
    "retains the route while $label",
    async ({ initialLocation, destination, initial, result, deps }) => {
      const nextData = createDeferredCore<ChatRouteData>();
      let loadCount = 0;
      const { teardown, module } = await ownedModule();
      const router = testRouter(
        page(
          "chat",
          module,
          () => (++loadCount === 1 ? initial : nextData.promise),
          (_context, routeLocation) => deps(routeLocation),
        ),
      );
      const outlet = createOutlet(router);
      await navigate(router, outlet, "chat", initialLocation);
      const firstView = outlet.querySelector("mcp-app-view");
      const navigation = router.navigate("chat", {}, undefined, destination);
      await settleOutlet(outlet);
      expectRetained(outlet, firstView, teardown);
      nextData.resolve(result);
      await navigation;
      await settleOutlet(outlet);
      if (result.kind === "session") {
        expectRetained(outlet, firstView, teardown);
      } else {
        expect(routeValue(outlet)?.textContent).toBe("chooser");
        expect(teardown).toHaveBeenCalledOnce();
      }
    },
  );
});
