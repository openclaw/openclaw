import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import {
  createPluginHttpRouteHandoff,
  registerPluginHttpRoute,
  withPluginHttpRouteRegistry,
} from "../../plugins/http-registry.js";
import {
  getPluginInstance,
  type PluginInstanceHandle,
} from "../../plugins/plugin-instance-scope.js";
import { projectPluginContributions } from "../../plugins/registry-contributions.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../../plugins/registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import {
  createGatewayPluginRequestHandler,
  createGatewayPluginUpgradeHandler,
} from "./plugins-http.js";

const instances = new Set<PluginInstanceHandle>();
const routeDefaults = { path: "/owned", auth: "plugin" as const };
type Route = Parameters<typeof registerPluginHttpRoute>[0];
type Handler = () => boolean | Promise<boolean>;
type OwnedRoute = { handler: Handler; handleUpgrade?: Handler };

function createOwner(id = "shared-route", route?: OwnedRoute) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  if (route) {
    api.registerHttpRoute({ ...routeDefaults, ...route });
  }
  const instance = getPluginInstance(record)!;
  instances.add(instance);
  return { registry: builder.registry, record, api, instance };
}

function registerDynamic(
  owner: ReturnType<typeof createOwner>,
  route: Omit<Route, "path" | "auth">,
  lease?: Parameters<typeof withPluginHttpRouteRegistry>[2],
) {
  const register = () =>
    registerPluginHttpRoute({ ...routeDefaults, ...route, throwOnFailure: true });
  owner.instance.run(() =>
    lease ? withPluginHttpRouteRegistry(owner.registry, register, lease) : register(),
  );
}

function observeRegistry() {
  const observed: Array<PluginRegistry | undefined> = [];
  const handler = () => {
    observed.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
    return true;
  };
  return { observed, handler };
}

async function dispatch(registry: PluginRegistry, transport: "HTTP" | "WebSocket" = "HTTP") {
  const warn = vi.fn();
  const log = { warn } as unknown as Parameters<typeof createGatewayPluginRequestHandler>[0]["log"];
  const req = { url: "/owned", method: "GET", headers: {} } as IncomingMessage;
  const response = makeMockHttpResponse();
  const socket = new PassThrough();
  const context = {
    gatewayAuthSatisfied: true,
    gatewayRequestOperatorScopes: ["operator.read"],
    gatewayRequestAuth: { authMethod: "token" as const, trustDeclaredOperatorScopes: false },
  };
  const http = createGatewayPluginRequestHandler({ registry, log });
  const upgrade = createGatewayPluginUpgradeHandler({ registry, log });
  try {
    if (transport === "HTTP") {
      await http(req, response.res, undefined, context);
    } else {
      await upgrade(req, socket, Buffer.alloc(0), undefined, context);
    }
    return { ...response, warnings: warn.mock.calls, socketDestroyed: socket.destroyed };
  } finally {
    socket.destroy();
  }
}

afterEach(async () => {
  await Promise.all([...instances].map((instance) => instance.dispose()));
  instances.clear();
});

it.each(["HTTP", "WebSocket"] as const)(
  "retains shared %s owner after retirement",
  async (transport) => {
    const { observed, handler } = observeRegistry();
    const first = createOwner("shared-route", { handler, handleUpgrade: handler });
    const second = createOwner("shared-route", { handler, handleUpgrade: handler });
    expect(first.registry.httpRoutes[0]?.handler).toBe(second.registry.httpRoutes[0]?.handler);

    const before = await dispatch(first.registry, transport);
    await second.instance.dispose();
    const after = await dispatch(first.registry, transport);

    expect(observed.map((registry) => registry === first.registry)).toEqual([true, true]);
    expect(before.warnings).toEqual([]);
    expect(after).toMatchObject({ warnings: [], res: { statusCode: 200 }, socketDestroyed: false });
  },
);

it.each(["static", "dynamic", "anonymous"] as const)(
  "preserves projected %s route ownership through nested calls",
  async (registration) => {
    const owner = createOwner();
    const { observed, handler } = observeRegistry();
    const nested = owner.instance.wrap(handler);
    const route = { ...routeDefaults, handler: () => nested() };
    if (registration === "static") {
      owner.api.registerHttpRoute(route);
    } else {
      registerDynamic(owner, {
        registry: owner.registry,
        ...route,
        ...(registration === "dynamic" ? { pluginId: owner.record.id } : {}),
      });
    }
    const selected = createEmptyPluginRegistry();
    selected.plugins.push(owner.record);
    projectPluginContributions(owner.registry, owner.record, selected);

    const response = await dispatch(selected);
    expect(observed.map((registry) => registry === selected)).toEqual([true]);
    expect(response.warnings).toEqual([]);
  },
);

it("uses the invoked upgrade callback's owner for an untracked route", async () => {
  const http = createOwner("http");
  const upgrade = createOwner("upgrade");
  const handleUpgrade = upgrade.instance.adopt(vi.fn(() => true));
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    ...routeDefaults,
    match: "exact",
    handler: http.instance.adopt(() => true),
    handleUpgrade,
  });
  await upgrade.instance.dispose();

  const response = await dispatch(registry, "WebSocket");
  expect(handleUpgrade).not.toHaveBeenCalled();
  expect(response).toMatchObject({
    socketDestroyed: true,
    warnings: [[expect.stringContaining("Plugin upgrade was reloaded")]],
  });
});

it("joins the selected route's in-flight response before disposing its instance", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const events: string[] = [];
  const handler = async () => {
    events.push("entered");
    entered.resolve();
    await release.promise;
    events.push("returned");
    return true;
  };
  const first = createOwner("shared-route", { handler });
  createOwner("shared-route", { handler });
  first.api.lifecycle.onDispose!(() => {
    events.push("disposed");
  });
  const pending = dispatch(first.registry);
  await entered.promise;
  const retirement = first.instance.dispose();
  try {
    await setImmediate();
    expect(events).toEqual(["entered"]);
  } finally {
    release.resolve();
    await Promise.all([pending, retirement]);
  }
  expect(events).toEqual(["entered", "returned", "disposed"]);
});

it("serves the host retry response after a dynamic route's instance retires", async () => {
  const owner = createOwner();
  const lease = createPluginRuntimeCapabilityLease("route-test");
  const handler = vi.fn(() => true);
  registerDynamic(owner, { handler }, lease);
  const handoff = createPluginHttpRouteHandoff();
  handoff.park(lease);
  lease.revoke();
  await owner.instance.dispose();
  try {
    const response = await dispatch(owner.registry);
    expect(response).toMatchObject({ res: { statusCode: 503 }, warnings: [] });
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(response.end).toHaveBeenCalledWith("plugin route is restarting; retry");
    expect(handler).not.toHaveBeenCalled();
  } finally {
    handoff.release();
  }
});
