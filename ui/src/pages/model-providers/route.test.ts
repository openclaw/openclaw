// @vitest-environment node
import { createRouter } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
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
const roster = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main" }, { id: "research" }],
} satisfies AgentsListResult;
const cleanups: Array<() => void> = [];

function responseFor(method: string): unknown {
  switch (method) {
    case "agents.list":
      return roster;
    case "models.authStatus":
      return { ts: 1, providers: [{ provider: "openai", status: "ok", profiles: [] }] };
    case "models.list":
      return { models: [{ id: "fixture", provider: "openai", name: "Fixture" }] };
    default:
      return {};
  }
}

function createModelsRouter(selectedId: string | null = "main") {
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  const request = vi
    .spyOn(store.gateway.snapshot.client!, "request")
    .mockImplementation(async (method) => responseFor(method));
  store.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
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
  const router = createRouter<
    "model-providers" | "other",
    typeof context,
    null,
    ModelProvidersRouteData
  >({
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
    navigate: (route: "model-providers" | "other" = "model-providers") =>
      router.navigate(route, context),
    data: () => router.getState().matches[0]?.data,
    catalog: () =>
      peekModelCatalog(store.gateway.snapshot.client!, { agentId: selection.state.selectedId! }),
    hello: () => store.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO }),
  };
}

type ModelsHarness = ReturnType<typeof createModelsRouter>;

function holdRoster(h: ModelsHarness) {
  const started = createDeferred();
  const response = createDeferred<typeof roster>();
  h.request.mockImplementation(async (method) => {
    if (method !== "agents.list") {
      return responseFor(method);
    }
    started.resolve();
    return response.promise;
  });
  return { started, response };
}

type OwnerChange = "navigation" | "disconnect" | "hello" | "client" | "set";

async function replaceOwner(h: ModelsHarness, change: OwnerChange) {
  if (change === "navigation") {
    await h.navigate("other");
  } else if (change === "disconnect") {
    h.current().opts.onClose?.({ code: 1012, reason: "restart", willRetry: true });
  } else if (change === "hello") {
    const admitted = h.gateway.snapshot;
    h.current().opts.onClose?.({ code: 1012, reason: "restart", willRetry: true });
    h.hello();
    expect(h.gateway.snapshot.client).toBe(admitted.client);
    expect(h.gateway.snapshot.hello).not.toBe(admitted.hello);
  } else if (change === "client") {
    h.gateway.connect();
    h.current().request.mockImplementation(async (method) => responseFor(method));
    h.hello();
  } else {
    h.selection.set("research");
  }
}

describe("Models route admission", () => {
  beforeEach(stubGatewayStoreTestGlobals);
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
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

  it.each<[OwnerChange, "import" | "roster"]>([
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
    const h = createModelsRouter(boundary === "roster" ? null : "main");
    const held = boundary === "roster" ? holdRoster(h) : null;
    const loading = h.navigate();
    if (held) {
      await held.started.promise;
    }
    // Even a cached import yields; real owner changes must precede requests.
    await replaceOwner(h, change);
    if (held) {
      if (["disconnect", "hello", "client"].includes(change)) {
        h.selection.set("main");
      }
      held.response.resolve(roster);
    }
    await loading;
    expect(h.modelCalls()).toEqual([]);
    if (boundary === "import") {
      if (h.gateway.snapshot.phase !== "connected") {
        h.hello();
      }
      await h.router.revalidate(h.context, "model-providers");
      expect(h.data()).toMatchObject({
        gateway: h.gateway,
        gatewaySnapshot: h.gateway.snapshot,
        client: h.gateway.snapshot.client,
        agentId: h.selection.state.selectedId,
        data: {
          authStatus: responseFor("models.authStatus"),
          error: null,
          updatedAt: expect.any(Number),
        },
      });
      expect(h.catalog()).toEqual(responseFor("models.list"));
    }
  });

  it.each(["import", "roster"] as const)(
    "accepts metadata and independent chat scope changes during %s",
    async (boundary) => {
      const h = createModelsRouter(boundary === "roster" ? null : "main");
      const admitted = h.gateway.snapshot;
      const { started, response } = holdRoster(h);
      const loading = h.navigate();
      if (boundary === "roster") {
        await started.promise;
      }
      h.current().opts.onRecoveryScopeChange?.();
      h.chatSelection.setScope(boundary === "import" ? null : "research");
      expect(h.gateway.snapshot).not.toBe(admitted);
      expect(h.gateway.snapshot.hello).toBe(admitted.hello);
      response.resolve(roster);
      await loading;
      expect(h.data()?.gatewaySnapshot).toBe(admitted);
      expect(h.data()).toMatchObject({
        gatewaySnapshot: admitted,
        agentId: "main",
        data: { error: null, updatedAt: expect.any(Number) },
      });
      expect(
        h
          .modelCalls()
          .map(([method]) => method)
          .toSorted(),
      ).toEqual(modelMethods.toSorted());
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
      const started = createDeferred();
      const response = createDeferred();
      let requests = 0;
      h.request.mockImplementation(async (method) => {
        if (modelMethods.includes(method)) {
          if (++requests === modelMethods.length) {
            started.resolve();
          }
          await response.promise;
        }
        return responseFor(method);
      });
      const loading =
        kind === "navigation" ? h.navigate() : h.router.preloadRoute("model-providers", h.context);
      await started.promise;
      await h.navigate("other");
      response.resolve();
      await loading;
      expect(h.router.getState().matches[0]?.routeId).toBe("other");
      expect(h.catalog()).toEqual(kind === "preload" ? responseFor("models.list") : undefined);
      await h.navigate();
      if (kind === "preload") {
        expect(h.modelCalls()).toHaveLength(modelMethods.length);
      } else {
        // The cancelled route releases its subscription; the connection-owned auth read survives.
        expect(h.modelCalls("models.authStatus")).toHaveLength(1);
        expect(h.modelCalls("models.list")).toHaveLength(2);
        expect(h.catalog()).toEqual(responseFor("models.list"));
      }
      expect(h.data()?.data.authStatus).toEqual(responseFor("models.authStatus"));
    },
  );
});
