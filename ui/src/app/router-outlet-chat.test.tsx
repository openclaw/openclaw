import type { RouteLocation } from "@openclaw/uirouter";
import { Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { SolidRouteProps } from "../app-route-types.tsx";
import { registerMcpAppUnmountTarget } from "../components/mcp-app-unmount.ts";
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

type RouteId = "chat" | "dashboard" | "home" | "new-session";
type TestContext = Record<string, never>;
type TestModule = OutletModule<ChatRouteData>;
const routes = routeFixtures<RouteId, TestContext, ChatRouteData>();
const page = routes.page;
const testRouter = routes.router;
type TestRouter = ReturnType<typeof testRouter>;
type RouterOutletElement = MountedRouterOutlet;
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const nextKey = "agent:main:dashboard:abcdef12-3456-7890-abcd-ef1234567890";

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

function presentedValue(outlet: RouterOutletElement) {
  return outlet.querySelector('[data-testid="route-value"][data-presented="true"]');
}

function appView(outlet: RouterOutletElement) {
  return outlet.querySelector("mcp-app-view");
}

function expectParked(outlet: RouterOutletElement, view: Element) {
  expect(view.isConnected).toBe(true);
  expect(view.closest("[inert]")).not.toBeNull();
  expect(presentedValue(outlet)).toBeNull();
}

async function finishNavigation<T>(
  outlet: RouterOutletElement,
  navigation: Promise<unknown>,
  pending: ReturnType<typeof createDeferredCore<T>>,
  data: T,
) {
  pending.resolve(data);
  await navigation;
  await settleOutlet(outlet);
}

function location(pathname: string, search = ""): RouteLocation {
  return { pathname, search, hash: "" };
}

function sessionData(key: string, face: "chat" | "dashboard"): ChatRouteData {
  return { kind: "session", sessionKey: key, agentId: "main", face, shortId: "12345678" };
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

let teardown: ReturnType<typeof vi.fn<() => Promise<void>>>;
let modules: Record<"chat" | "dashboard", TestModule>;
beforeEach(async () => {
  teardown = vi.fn(async () => undefined);
  const render = ownedRenderer(teardown);
  modules = {
    chat: await routeModule("chat", render),
    dashboard: await routeModule("dashboard", render),
  };
});

function expectRetained(
  outlet: RouterOutletElement,
  view: Element | null,
  retire: () => Promise<void>,
) {
  expect(appView(outlet)).toBe(view);
  expect(retire).not.toHaveBeenCalled();
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
  it("parks the loaded session on Home and restores its draft on return", async () => {
    const refreshed = createDeferredCore<ChatRouteData>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(sessionData(sessionKey, "chat"))
      .mockImplementation(() => refreshed.promise);
    const router = testRouter(
      page("chat", modules.chat, loader),
      page("home", { renderSolid: () => <div data-testid="ordinary-route">Home</div> }),
    );
    const outlet = createOutlet(router);
    await navigate(router, outlet, "chat");
    const view = appView(outlet)!;
    const draft = outlet.querySelector<HTMLTextAreaElement>('[data-testid="route-draft"]')!;
    draft.value = "Keep this unfinished message";

    await navigate(router, outlet, "home");
    expect(outlet.querySelector('[data-testid="ordinary-route"]')?.textContent).toBe("Home");
    expectParked(outlet, view);
    expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("false");
    expect(teardown).not.toHaveBeenCalled();

    const navigation = router.navigate("chat", {});
    await settleOutlet(outlet);
    expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("true");
    await finishNavigation(outlet, navigation, refreshed, sessionData(sessionKey, "chat"));
    expect(appView(outlet)).toBe(view);
    expect(outlet.querySelector('[data-testid="route-draft"]')).toBe(draft);
    expect(draft.value).toBe("Keep this unfinished message");
    expect(view.closest("[inert]")).toBeNull();
    expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("true");
    expect(outlet.querySelector('[data-testid="ordinary-route"]')).toBeNull();
    expect(teardown).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains the session subtree across presentation switches (parked: %s)",
    async (parked) => {
      const nextData = createDeferredCore<ChatRouteData>();
      const router = testRouter(
        page("chat", modules.chat, sessionData(sessionKey, "chat")),
        page("dashboard", modules.dashboard, nextData.promise),
        page("home", { renderSolid: () => <div>Home</div> }),
      );
      const outlet = createOutlet(router);
      await navigate(router, outlet, "chat");
      const view = appView(outlet)!;
      if (parked) {
        await navigate(router, outlet, "home");
      }
      const navigation = router.navigate("dashboard", {});
      await settleOutlet(outlet);
      expectRetained(outlet, view, teardown);
      if (parked) {
        expectParked(outlet, view);
      } else {
        expect(routeValue(outlet)?.textContent).toBe("chat");
      }
      await finishNavigation(outlet, navigation, nextData, sessionData(nextKey, "dashboard"));
      expectRetained(outlet, view, teardown);
      expect(view.closest("[inert]")).toBeNull();
      expect(routeValue(outlet)?.textContent).toBe("dashboard");
    },
  );

  it("retires parked views and uses the replacement scope's route data", async () => {
    let scope = { key: 1 };
    const teardownDone = createDeferredCore();
    teardown.mockImplementation(() => teardownDone.promise);
    const nextData = createDeferredCore<ChatRouteData>();
    const loader = vi
      .fn()
      .mockResolvedValueOnce(sessionData(sessionKey, "chat"))
      .mockImplementation(() => nextData.promise);
    const router = testRouter(
      page("chat", modules.chat, loader, () => String(scope.key)),
      page("home", { renderSolid: () => <div>Home</div> }),
    );
    const outlet = createOutlet(router);
    outlet.setInputs({ retentionScope: scope });
    await navigate(router, outlet, "chat");
    const view = appView(outlet)!;
    await navigate(router, outlet, "home");

    scope = { key: 2 };
    outlet.setInputs({ retentionScope: scope });
    await settleOutlet(outlet);
    expect(teardown).toHaveBeenCalledOnce();
    expectParked(outlet, view);
    expect(routeValue(outlet)?.getAttribute("data-presented")).toBe("false");

    const navigation = router.navigate("chat", {});
    await settleOutlet(outlet);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(view.closest("[inert]")).not.toBeNull();
    await finishNavigation(outlet, navigation, nextData, sessionData(nextKey, "chat"));
    expectParked(outlet, view);
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
    expect(view.isConnected).toBe(false);
    expect(appView(outlet)).not.toBeNull();
    expect(appView(outlet)?.closest("[inert]")).toBeNull();
    expect(outlet.presentationSettled).toBe(true);
  });

  it("keeps a pending destination and ignores its retired scope's late result", async () => {
    let scope = { key: 1 };
    const oldResult = createDeferredCore<ChatRouteData>();
    const newResult = createDeferredCore<ChatRouteData>();
    const loader = vi
      .fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementation(() => newResult.promise);
    const router = testRouter(
      page("dashboard", modules.dashboard, loader, (_context, routeLocation) =>
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
    await finishNavigation(outlet, navigation, oldResult, sessionData(sessionKey, "chat"));
    expect(routeValue(outlet)).toBeNull();
    newResult.resolve(sessionData(sessionKey, "dashboard"));
    await vi.waitFor(() => expect(routeValue(outlet)?.textContent).toBe("dashboard"));
    expect(router.getState().location).toEqual(destination);
  });

  it("does not revive a retired session when cold navigation supersedes its scope refresh", async () => {
    let scope = { key: 1 };
    const dashboardModule = createDeferredCore<TestModule>();
    const homeModule = createDeferredCore<TestModule>();
    const router = testRouter(
      page(
        "chat",
        modules.chat,
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
    dashboardModule.resolve(modules.dashboard);
    await dashboardNavigation;
    await settleOutlet(outlet);
    expect(presentedValue(outlet)).toBeNull();
    homeModule.resolve({ renderSolid: () => <div data-testid="ordinary-route">Home</div> });
    await homeNavigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector('[data-testid="ordinary-route"]')?.textContent).toBe("Home");
  });

  it("keeps a returning session inert until its pending MCP teardown completes", async () => {
    const done = createDeferredCore();
    teardown.mockImplementation(() => done.promise);
    const router = testRouter(
      page("chat", modules.chat, () => sessionData(sessionKey, "chat")),
      page(
        "dashboard",
        { ...modules.chat, renderSolid: () => <p>Session not found</p> },
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
    const view = appView(outlet)!;
    await navigate(router, outlet, "dashboard");
    expect(teardown).toHaveBeenCalledOnce();
    await navigate(router, outlet, "chat");
    expectParked(outlet, view);
    done.resolve(undefined);
    await vi.waitFor(() => expect(view.closest("[inert]")).toBeNull());
    expect(appView(outlet)).toBe(view);
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("retires the old page without reloading a replacement router's current result", async () => {
    const loader = vi.fn(() => sessionData(sessionKey, "chat"));
    const create = () => testRouter(page("chat", modules.chat, loader));
    const first = create();
    const second = create();
    const outlet = createOutlet(first);
    await navigate(first, outlet, "chat");
    const view = appView(outlet);
    await second.navigate("chat", {});
    outlet.setInputs({ router: second });
    await settleOutlet(outlet);
    expect(appView(outlet)).not.toBe(view);
    expect(appView(outlet)).not.toBeNull();
    expect(teardown).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("retains an unresolved route until its missing-session result replaces it", async () => {
    const nextData = createDeferredCore<ChatRouteData>();
    let loadCount = 0;
    const router = testRouter(
      page(
        "chat",
        modules.chat,
        () => (++loadCount === 1 ? sessionData(sessionKey, "chat") : nextData.promise),
        (_context, routeLocation) => routeLocation.pathname,
      ),
    );
    const outlet = createOutlet(router);
    await navigate(router, outlet, "chat", location("/chat/main/alpha-12345678"));
    const firstView = appView(outlet);
    const navigation = router.navigate("chat", {}, undefined, location("/chat/main/beta-12345678"));
    await settleOutlet(outlet);
    expectRetained(outlet, firstView, teardown);
    await finishNavigation(outlet, navigation, nextData, {
      kind: "missing-session",
      face: "chat",
      currentSessionHref: "/chat/main",
      sessionsHref: "/sessions",
    });
    expect(routeValue(outlet)?.textContent).toBe("chooser");
    expect(teardown).toHaveBeenCalledOnce();
  });
});
