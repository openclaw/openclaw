// @vitest-environment node
import { createRouter } from "@openclaw/uirouter";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { page, type ModelProvidersRouteData } from "./route.ts";

const modelMethods = ["models.authStatus", "models.list"];
const modelsHello = {
  ...GATEWAY_STORE_TEST_HELLO,
  auth: { role: "operator", scopes: ["operator.read"] },
  snapshot: {
    presence: [{ ts: 1, instanceId: "models-route-client", user: { id: "models-route-user" } }],
  },
};
const authStatus = { ts: 1, providers: [{ provider: "openai", status: "ok", profiles: [] }] };
const catalog = { models: [{ id: "fixture", provider: "openai", name: "Fixture" }] };
const roster = makeBootRoster({
  agents: [{ id: "main" }, { id: "research" }],
}) satisfies AgentsListResult;
const cleanups: Array<() => void> = [];
type RouteId = "model-providers" | "other";

const responses: Record<string, unknown> = {
  "agents.list": roster,
  "models.authStatus": authStatus,
  "models.list": catalog,
};
const responseFor = async (method: string) => structuredClone(responses[method] ?? {});

function createModelsRouter(selectedId: string | null = "main") {
  const store = createGatewayStoreTestStore({
    clientOptions: { instanceId: "models-route-client" },
  });
  store.gateway.start();
  const request = vi
    .spyOn(store.gateway.snapshot.client!, "request")
    .mockImplementation(responseFor);
  store.current().testOptions.onHello?.({ ...modelsHello });
  // Match bootstrap's subscription order; the roster publishes before selection reconciles.
  const agents = createAgentCapability(store.gateway);
  const chatSelection = createAgentSelectionCapability(store.gateway, agents);
  const selection = createAgentSelectionCapability(store.gateway, agents, undefined, undefined, {
    requireConfiguredAgent: true,
  });
  selection.set(selectedId);
  const context = Object.freeze({
    gateway: store.gateway,
    agents,
    settingsAgentSelection: selection,
  }) satisfies Parameters<NonNullable<typeof page.loader>>[0];
  const router = createRouter<RouteId, typeof context, null, ModelProvidersRouteData>({
    routes: [
      { ...page, component: () => null },
      { id: "other", path: "/other", component: () => null },
    ],
  });
  cleanups.push(() => {
    router.stop();
    selection.dispose();
    chatSelection.dispose();
    agents.dispose();
    store.gateway.stop();
  });
  return {
    ...store,
    context,
    selection,
    chatSelection,
    router,
    request,
    modelCalls: (method?: string) =>
      store.clients.flatMap((client) =>
        client.request.mock.calls.filter(([name]) =>
          method ? name === method : modelMethods.includes(name),
        ),
      ),
    navigate: (route: RouteId = "model-providers") => router.navigate(route, context),
    data: () => router.getState().matches[0]?.data,
    catalog: () =>
      peekModelCatalog(store.gateway.snapshot.client!, { agentId: selection.state.selectedId! }),
    hello: () => store.current().testOptions.onHello?.({ ...modelsHello }),
    disconnect: () =>
      store.current().testOptions.onClose?.({ code: 1012, reason: "restart", willRetry: true }),
  };
}

type ModelsHarness = ReturnType<typeof createModelsRouter>;
function expectLoaded(h: ModelsHarness, snapshot = h.gateway.snapshot) {
  expect(h.data()).toMatchObject({
    gateway: h.gateway,
    gatewaySnapshot: snapshot,
    client: snapshot.client,
    agentId: h.selection.state.selectedId,
    data: { authStatus, error: null, updatedAt: expect.any(Number) },
  });
  expect(h.catalog()).toEqual(catalog);
}

function holdRequests(h: ModelsHarness, methods = ["agents.list"]) {
  const started = createDeferred();
  const response = createDeferred();
  const seen = new Set<string>();
  h.request.mockImplementation(async (method) => {
    if (methods.includes(method)) {
      seen.add(method);
      if (seen.size === methods.length) {
        started.resolve();
      }
      await response.promise;
    }
    return responseFor(method);
  });
  return { started, response };
}

type OwnerChange = "navigation" | "disconnect" | "hello" | "client" | "set";
type Boundary = "import" | "roster";

async function atBoundary(boundary: Boundary, change: (h: ModelsHarness) => void | Promise<void>) {
  const h = createModelsRouter(boundary === "roster" ? null : "main");
  const admitted = h.gateway.snapshot;
  const held = holdRequests(h);
  const loading = h.navigate();
  if (boundary === "roster") {
    await held.started.promise;
  }
  // Invoke before awaiting: cached imports still have to observe the owner change.
  await change(h);
  held.response.resolve();
  await loading;
  return { h, admitted };
}

async function replaceOwner(h: ModelsHarness, change: OwnerChange) {
  if (change === "navigation") {
    await h.navigate("other");
  } else if (change === "disconnect") {
    h.disconnect();
  } else if (change === "hello") {
    const admitted = h.gateway.snapshot;
    h.disconnect();
    h.hello();
    expect(h.gateway.snapshot.client).toBe(admitted.client);
    expect(h.gateway.snapshot.hello).not.toBe(admitted.hello);
  } else if (change === "client") {
    h.gateway.connect();
    h.current().request.mockImplementation(responseFor);
    h.hello();
  } else {
    h.selection.set("research");
  }
}

beforeEach(stubGatewayStoreTestGlobals);
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  setAvatarGatewayOrigin(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([true, false])("preserves provider deep links when connected=%s", async (connected) => {
  const h = createModelsRouter();
  if (!connected) {
    await replaceOwner(h, "disconnect");
  }
  await h.router.navigateLocation(
    {
      pathname: "/settings/model-providers",
      search: "?connect=1&provider=%20openai%20",
      hash: "",
    },
    h.context,
  );
  expect(h.data()).toMatchObject({
    connect: true,
    provider: "openai",
    client: connected ? h.gateway.snapshot.client : null,
  });
});

it.each<[OwnerChange, Boundary]>([
  ["navigation", "import"],
  ["disconnect", "import"],
  ["hello", "import"],
  ["client", "import"],
  ["set", "import"],
  ["navigation", "roster"],
  ["disconnect", "roster"],
  ["hello", "roster"],
  ["client", "roster"],
  ["set", "roster"],
])("retires %s during %s before dispatch", async (change, boundary) => {
  const { h } = await atBoundary(boundary, async (current) => {
    await replaceOwner(current, change);
    if (boundary === "roster" && ["disconnect", "hello", "client"].includes(change)) {
      current.selection.set("main");
    }
  });
  expect(h.modelCalls()).toEqual([]);
  if (boundary === "import") {
    if (h.gateway.snapshot.phase !== "connected") {
      h.hello();
    }
    await h.router.revalidate(h.context, "model-providers");
    expectLoaded(h);
  }
});

it.each(["import", "roster"] as const)(
  "accepts metadata and independent chat scope changes during %s",
  async (boundary) => {
    const { h, admitted } = await atBoundary(boundary, (current) => {
      const original = current.gateway.snapshot;
      current.current().testOptions.onRecoveryScopeChange?.();
      current.chatSelection.setScope(boundary === "import" ? null : "research");
      expect(current.gateway.snapshot).not.toBe(original);
      expect(current.gateway.snapshot.hello).toBe(original.hello);
    });
    expect(h.data()?.gatewaySnapshot).toBe(admitted);
    expectLoaded(h, admitted);
    const methods = h.modelCalls().map(([method]) => method);
    expect(methods.toSorted()).toEqual(modelMethods.toSorted());
    expect(h.context.settingsAgentSelection.state.selectedId).toBe("main");
  },
);

it("does not initialize agents after navigation cancels the deferred import", async () => {
  const h = createModelsRouter(null);
  const loading = h.navigate();
  await h.navigate("other");
  await loading;
  expect(h.request).not.toHaveBeenCalledWith("agents.list", expect.anything());
  expect(h.modelCalls()).toEqual([]);
});

it("leaves roster failure to the agent owner without starting Models requests", async () => {
  const h = createModelsRouter(null);
  h.request.mockRejectedValue(new Error("roster unavailable"));
  await h.navigate();
  expect(h.context.agents.state.agentsError).toBe("roster unavailable");
  expect(h.modelCalls()).toEqual([]);
  expect(h.data()).toMatchObject({
    client: null,
    agentId: null,
    data: { updatedAt: null },
  });
});

it.each(["navigation", "preload"] as const)(
  "keeps %s cancellation ownership through auth and catalog reads",
  async (kind) => {
    const h = createModelsRouter();
    const { started, response } = holdRequests(h, modelMethods);
    const loading =
      kind === "navigation" ? h.navigate() : h.router.preloadRoute("model-providers", h.context);
    await started.promise;
    await h.navigate("other");
    response.resolve();
    await loading;
    expect(h.router.getState().matches[0]?.routeId).toBe("other");
    expect(h.catalog()).toEqual(kind === "preload" ? catalog : undefined);
    await h.navigate();
    if (kind === "preload") {
      expect(h.modelCalls()).toHaveLength(modelMethods.length);
    } else {
      // The cancelled route releases its subscription; the connection-owned auth read survives.
      expect(h.modelCalls("models.authStatus")).toHaveLength(1);
      expect(h.modelCalls("models.list")).toHaveLength(2);
      expect(h.catalog()).toEqual(catalog);
    }
    expect(h.data()?.data.authStatus).toEqual(authStatus);
  },
);
