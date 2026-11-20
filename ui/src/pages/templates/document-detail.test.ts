/* @vitest-environment jsdom */
import type { RouteLocation } from "@openclaw/uirouter";
import { expect, it, onTestFinished } from "vitest";
import { createApplicationRouter, startApplicationRouter } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { isTemplatesAvailable } from "./availability.ts";

const pin = { packageName: "@maker/travel", version: "1.2.0" };
const location = {
  pathname: "/templates/packages/%40maker%2Ftravel",
  search: "?version=1.2.0",
  hash: "",
};
const enabled = { gateway: { controlUi: { experimental: { templates: true } } } };
const detail = {
  ...pin,
  latestVersion: pin.version,
  displayName: "Travel Planner",
  summary: "Build a trip itinerary.",
  channel: "community",
  ownerHandle: "maker",
  agentId: "travel",
  contents: {
    instructions: [{ name: "AGENTS.md", source: "workspace/AGENTS.md" }],
    skills: [],
    integrations: [],
    automations: [],
  },
};

async function openDocument({
  initialLocation = location,
  documentLocation = initialLocation,
  stopped = false,
}: { initialLocation?: RouteLocation; documentLocation?: RouteLocation; stopped?: boolean } = {}) {
  const configReply = Promise.withResolvers<unknown>();
  const request = createGatewayRequestMock(async (method) => {
    if (method === "config.get") {
      return configReply.promise;
    }
    if (method === "templates.catalog.detail") {
      return { detail };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const { gateway, publish } = createApplicationGateway();
  if (!stopped) {
    publish({ ...gateway.snapshot, phase: "connecting", client });
  }
  const agents = createAgentCapability(gateway);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const router = createApplicationRouter();
  const lifetime = new AbortController();
  const routeContext: Pick<
    ApplicationContext,
    "basePath" | "agents" | "gateway" | "runtimeConfig" | "router" | "lifecycleAbortSignal"
  > = {
    basePath: "",
    agents,
    gateway,
    runtimeConfig,
    router,
    lifecycleAbortSignal: lifetime.signal,
  };
  // This fixture hosts only the production Template route and renderer, not other pages.
  const context = routeContext as ApplicationContext;
  const route = router.getRoute("templates")!;
  const component = route.component;
  const renderer = Promise.withResolvers<void>();
  route.component = async () => {
    await renderer.promise;
    return component();
  };
  const loader = route.loader!;
  const loaded = Promise.withResolvers<void>();
  route.loader = async (...args) => {
    const data = await loader(...args);
    loaded.resolve();
    return data;
  };
  let current: RouteLocation = initialLocation;
  const write = (next: RouteLocation) => {
    current = next;
  };
  const navigation = startApplicationRouter(
    router,
    { location: () => current, push: write, replace: write, listen: () => () => {} },
    "",
    context,
    documentLocation,
  );
  onTestFinished(async () => {
    lifetime.abort();
    router.stop();
    renderer.resolve();
    await navigation;
    runtimeConfig.dispose();
    agents.dispose();
  });
  // Login/shell cannot depend on a future hello. The real foreground loader must return
  // while both the authenticated transport and the required route module are unavailable.
  await loaded.promise;
  expect(router.getState().pendingMatches[0]).toMatchObject({
    cause: "navigation",
    routeId: "templates",
  });
  expect(request.mock.calls).toEqual([]);
  const hello = gatewayHelloForMethods(
    ["templates.catalog.detail", "templates.add.apply"],
    ["operator.read"],
  );
  const connect = (overrides: Partial<typeof gateway.snapshot> = {}) =>
    publish({ ...gateway.snapshot, client, phase: "connected", hello, ...overrides });
  const apply = async (value = true) => {
    const applied = Promise.withResolvers<void>();
    const stop = runtimeConfig.subscribe((state) => {
      if (isTemplatesAvailable(state) === value) {
        applied.resolve();
      }
    });
    configReply.resolve({
      config: value ? enabled : {},
      configRevisionHash: "applied",
      appliedConfigHash: "applied",
    });
    await applied.promise;
    stop();
  };
  const mount = () => {
    const match = router.getState().matches[0]!;
    const view = mountSolid(
      () => match.module!.renderSolid({ data: match.data, loaderPending: false, presented: true }),
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    onTestFinished(view.unmount);
    return view;
  };
  return {
    connect,
    apply,
    mount,
    gateway,
    publish,
    client,
    runtimeConfig,
    router,
    lifetime,
    context,
    navigation,
    renderer,
    request,
    hello,
  };
}

it("sends one admitted document pin before its renderer, then mounts the settled detail without a second read", async () => {
  const f = await openDocument();
  f.connect();
  expect(f.request.mock.calls).toEqual([["config.get", {}]]);
  await f.apply();
  expect(f.router.getState().pendingMatches[0]?.module).toBeUndefined();
  const expected = [
    ["config.get", {}],
    ["templates.catalog.detail", pin],
  ];
  expect(f.request.mock.calls, "eligible before the required renderer is available").toEqual(
    expected,
  );
  f.renderer.resolve();
  await f.navigation;
  const match = f.router.getState().matches[0]!;
  expect(match.location).toEqual(location);
  const view = f.mount();
  await waitForSolid(() => expect(view.container.textContent).toContain("Build a trip itinerary."));
  expect(f.request.mock.calls).toEqual(expected);
  view.unmount();
  await f.router.navigate(
    "templates",
    f.context,
    { history: "push" },
    { pathname: "/templates", search: "", hash: "" },
  );
  await f.router.navigate("templates", f.context, { history: "push" }, location);
  expect(f.request.mock.calls).toEqual([...expected, ["templates.catalog.detail", pin]]);
});

it("lets the router start and present its shell without authentication, leaving admission to the mounted page", async () => {
  const f = await openDocument({ stopped: true });
  f.renderer.resolve();
  await f.navigation;
  expect(f.router.getState().status).toBe("success");
  expect(f.request.mock.calls).toEqual([]);
  const view = f.mount();
  expect(view.container.querySelector(".plugin-catalog-detail--loading")).not.toBeNull();
  f.connect();
  await f.apply();
  await waitForSolid(() => expect(view.container.textContent).toContain("Build a trip itinerary."));
  expect(f.request.mock.calls).toEqual([
    ["config.get", {}],
    ["templates.catalog.detail", pin],
  ]);
});

type DocumentVisit = Awaited<ReturnType<typeof openDocument>>;
const retirements: Record<string, (f: DocumentVisit) => void> = {
  disposal: (f) => f.lifetime.abort(),
  "new version": (f) =>
    void f.router.navigate(
      "templates",
      f.context,
      { history: "push" },
      { ...location, search: "?version=2.0.0" },
    ),
  "new route": (f) =>
    void f.router.navigate(
      "templates",
      f.context,
      { history: "push" },
      { pathname: "/templates", search: "", hash: "" },
    ),
  "new client": (f) =>
    f.publish({ ...f.gateway.snapshot, client: createTestGatewayClient(f.request) }),
  "changed account": (f) => f.connect({ selfUser: { id: "first" } }),
  "new hello": (f) => f.connect({ hello: { ...f.hello } }),
  credentials: (f) => {
    Object.defineProperty(f.gateway, "connectionRevision", { value: 1 });
  },
  "login failure": (f) =>
    f.publish({ ...f.gateway.snapshot, lastError: "Pairing required", offlineStable: true }),
  "lost transport": (f) => f.publish({ ...f.gateway.snapshot, phase: "offline" }),
  "scope denial": (f) =>
    f.connect({ hello: gatewayHelloForMethods(["templates.catalog.detail"], []) }),
  "method denial": (f) => f.connect({ hello: gatewayHelloForMethods([], ["operator.read"]) }),
};
it.each(Object.entries(retirements))(
  "retires the missed read permanently on %s",
  async (_, retire) => {
    const f = await openDocument();
    retire(f);
    f.connect({ selfUser: { id: "second" }, lastError: null, offlineStable: false });
    // An explicit ensure can admit config after scopes return on the same client;
    // the abandoned document must not start detail even at this known-enabled point.
    const ensure = f.runtimeConfig.ensureDisplayLoaded();
    await f.apply();
    await ensure;
    expect(
      f.request.mock.calls.filter(([method]) => method === "templates.catalog.detail"),
    ).toEqual([]);
  },
);

it("does not restart the document navigation when a stopped router's renderer finally resolves", async () => {
  const f = await openDocument();
  f.router.stop();
  f.connect();
  await f.apply();
  f.renderer.resolve();
  await f.navigation;
  expect(f.request.mock.calls).toEqual([["config.get", {}]]);
  expect(f.router.getState().status).toBe("idle");
});

it("does not revive a denied document when a later config enables Labs", async () => {
  const f = await openDocument();
  f.connect();
  await f.apply(false);
  f.request.mockImplementationOnce(async () => ({ config: enabled }));
  await f.runtimeConfig.refreshDisplay();
  expect(isTemplatesAvailable(f.runtimeConfig.state)).toBe(true);
  expect(f.request.mock.calls).toEqual([
    ["config.get", {}],
    ["config.get", {}],
  ]);
});

it.each(["", "?version=latest", "?version=%5E1.2.0", "?version=1.2.0&agent=a&draft=mine"])(
  "does not arm an unpinned or draft document (%s)",
  async (search) => {
    const f = await openDocument({ initialLocation: { ...location, search } });
    f.connect();
    await f.apply();
    expect(f.request.mock.calls).toEqual([["config.get", {}]]);
  },
);

it("does not treat a queued navigation from a different document as a direct entry", async () => {
  const f = await openDocument({
    documentLocation: { pathname: "/templates", search: "", hash: "" },
  });
  f.connect();
  await f.apply();
  expect(f.request.mock.calls).toEqual([["config.get", {}]]);
});

it("presents the prepared failure and sends a fresh read only when Retry is clicked", async () => {
  const f = await openDocument();
  f.connect();
  f.request.mockRejectedValueOnce(new Error("This release is unavailable"));
  await f.apply();
  f.renderer.resolve();
  await f.navigation;
  const view = f.mount();
  await waitForSolid(() =>
    expect(view.container.querySelector("[role=alert]")?.textContent).toContain(
      "This release is unavailable",
    ),
  );
  expect(f.request.mock.calls).toEqual([
    ["config.get", {}],
    ["templates.catalog.detail", pin],
  ]);
  view.container.querySelector<HTMLButtonElement>("[role=alert] button")!.click();
  await waitForSolid(() => expect(view.container.textContent).toContain("Build a trip itinerary."));
  expect(f.request.mock.calls).toEqual([
    ["config.get", {}],
    ["templates.catalog.detail", pin],
    ["templates.catalog.detail", pin],
  ]);
});

it("discards an already prepared receipt on denial, even if access is restored before the first mount", async () => {
  const f = await openDocument();
  f.connect();
  await f.apply();
  f.renderer.resolve();
  await f.navigation;
  const denied = { ...f.gateway.snapshot, hello: gatewayHelloForMethods([], ["operator.read"]) };
  f.publish(denied);
  f.connect();
  const view = f.mount();
  await waitForSolid(() => expect(view.container.textContent).toContain("Build a trip itinerary."));
  expect(f.request.mock.calls).toEqual([
    ["config.get", {}],
    ["templates.catalog.detail", pin],
    ["templates.catalog.detail", pin],
  ]);
});
