import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { createMockSubsystemLogger } from "../../../test/helpers/mock-subsystem-logger.js";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import {
  createPluginHttpRouteHandoff,
  registerPluginHttpRoute,
  withPluginHttpRouteRegistry,
} from "../../plugins/http-registry.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
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

const routeDefaults = { path: "/owned", auth: "plugin" as const };
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
  onTestFinished(async () => {
    await instance.dispose();
  });
  return { registry: builder.registry, record, api, instance };
}

async function dispatch(registry: PluginRegistry, transport: "HTTP" | "WebSocket" = "HTTP") {
  const log = createMockSubsystemLogger("test/plugin-ownership");
  const req = { url: "/owned", method: "GET", headers: {} } as IncomingMessage;
  const response = makeMockHttpResponse();
  const socket = new PassThrough();
  onTestFinished(() => {
    socket.destroy();
  });
  if (transport === "HTTP") {
    await createGatewayPluginRequestHandler({ registry, log })(req, response.res);
  } else {
    await createGatewayPluginUpgradeHandler({ registry, log })(req, socket, Buffer.alloc(0));
  }
  return { ...response, socketDestroyed: socket.destroyed };
}

it.each(["HTTP", "WebSocket"] as const)("drains the surviving %s owner", async (transport) => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const events: string[] = [];
  const observed: Array<PluginRegistry | undefined> = [];
  const handler = async () => {
    observed.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
    entered.resolve();
    await release.promise;
    events.push("returned");
    return true;
  };
  const first = createOwner("shared-route", { handler, handleUpgrade: handler });
  const second = createOwner("shared-route", { handler, handleUpgrade: handler });
  first.api.lifecycle.onDispose!(() => {
    events.push("disposed");
  });
  await second.instance.dispose();
  const pending = dispatch(first.registry, transport);
  await entered.promise;
  const retirement = first.instance.dispose();
  try {
    await setImmediate();
    expect(events).toEqual([]);
  } finally {
    release.resolve();
    await Promise.all([pending, retirement]);
  }
  expect(await pending).toMatchObject({ res: { statusCode: 200 }, socketDestroyed: false });
  expect(events).toEqual(["returned", "disposed"]);
  expect(observed).toEqual([first.registry]);
});

it.each(["static", "dynamic", "anonymous"] as const)(
  "projects %s ownership",
  async (registration) => {
    const owner = createOwner();
    const observed = vi.fn(() => getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
    const nested = owner.instance.wrap(() => Boolean(observed()));
    const route = { ...routeDefaults, handler: () => nested() };
    if (registration === "static") {
      owner.api.registerHttpRoute(route);
    } else {
      owner.instance.run(() =>
        registerPluginHttpRoute({
          ...route,
          pluginId: registration === "dynamic" ? owner.record.id : undefined,
          throwOnFailure: true,
        }),
      );
    }
    const selected = createEmptyPluginRegistry();
    selected.plugins.push(owner.record);
    projectPluginContributions(owner.registry, owner.record, selected);

    expect((await dispatch(selected)).res.statusCode).toBe(200);
    expect(observed.mock.results.map(({ value }) => value === selected)).toEqual([true]);
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
  expect(response.socketDestroyed).toBe(true);
});

it("serves the host retry response after a dynamic route's instance retires", async () => {
  const owner = createOwner();
  const lease = createPluginRuntimeCapabilityLease("route-test");
  const handler = vi.fn(() => true);
  owner.instance.run(() =>
    withPluginHttpRouteRegistry(
      owner.registry,
      () => registerPluginHttpRoute({ ...routeDefaults, handler, throwOnFailure: true }),
      lease,
    ),
  );
  const handoff = createPluginHttpRouteHandoff();
  onTestFinished(handoff.release);
  handoff.park(lease);
  lease.revoke();
  await owner.instance.dispose();
  const response = await dispatch(owner.registry);
  expect(response.res.statusCode).toBe(503);
  expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
  expect(response.end).toHaveBeenCalledWith("plugin route is restarting; retry");
  expect(handler).not.toHaveBeenCalled();
});
