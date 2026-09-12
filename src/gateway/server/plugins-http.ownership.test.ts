import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import {
  createPluginHttpRouteHandoff,
  registerPluginHttpRoute,
  withPluginHttpRouteRegistry,
} from "../../plugins/http-registry.js";
import { runPluginRegisterSyncInRegistry } from "../../plugins/loader-module-runtime.js";
import { resolvePluginModuleExport } from "../../plugins/module-export.js";
import {
  getPluginInstance,
  type PluginInstanceHandle,
} from "../../plugins/plugin-instance-scope.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { projectPluginContributions } from "../../plugins/registry-contributions.js";
import {
  createEmptyPluginRegistry,
  createPluginRegistry,
  type PluginRegistry,
} from "../../plugins/registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import {
  createGatewayPluginRequestHandler,
  createGatewayPluginUpgradeHandler,
} from "./plugins-http.js";

const instances = new Set<PluginInstanceHandle>();

function createOwner(
  id = "shared-route",
  builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  }),
) {
  const record = createPluginRecord({ id });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record)!;
  instances.add(instance);
  return { builder, registry: builder.registry, record, api, instance };
}

async function dispatch(
  registry: PluginRegistry,
  transport: "HTTP" | "WebSocket" = "HTTP",
  path = "/owned",
) {
  const warn = vi.fn();
  const log = { warn } as unknown as Parameters<typeof createGatewayPluginRequestHandler>[0]["log"];
  const req = { url: path, method: "GET", headers: {} } as IncomingMessage;
  const response = makeMockHttpResponse();
  const socket = new PassThrough();
  const context = {
    gatewayAuthSatisfied: true,
    gatewayRequestOperatorScopes: ["operator.read"],
    gatewayRequestAuth: { authMethod: "token" as const, trustDeclaredOperatorScopes: false },
  };
  try {
    const handled =
      transport === "HTTP"
        ? await createGatewayPluginRequestHandler({ registry, log })(
            req,
            response.res,
            undefined,
            context,
          )
        : await createGatewayPluginUpgradeHandler({ registry, log })(
            req,
            socket,
            Buffer.alloc(0),
            undefined,
            context,
          );
    return { ...response, handled, warn, socketDestroyed: socket.destroyed };
  } finally {
    socket.destroy();
  }
}

afterEach(async () => {
  await Promise.all([...instances].map((instance) => instance.dispose()));
  instances.clear();
});

describe("plugin HTTP route instance ownership", () => {
  it.each(["HTTP", "WebSocket"] as const)(
    "keeps a shared raw %s handler with its selected registration after another instance retires",
    async (transport) => {
      const observed: Array<PluginRegistry | undefined> = [];
      const handler = () => {
        observed.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
        return true;
      };
      const first = createOwner();
      const second = createOwner();
      for (const { api } of [first, second]) {
        api.registerHttpRoute({ path: "/owned", auth: "plugin", handler, handleUpgrade: handler });
      }
      expect(first.registry.httpRoutes[0]?.handler).toBe(second.registry.httpRoutes[0]?.handler);

      const beforeRetirement = await dispatch(first.registry, transport);
      await second.instance.dispose();
      const afterRetirement = await dispatch(first.registry, transport);

      expect(observed).toHaveLength(2);
      expect(observed[0]).toBe(first.registry);
      expect(observed[1]).toBe(first.registry);
      expect(beforeRetirement.warn).not.toHaveBeenCalled();
      expect(afterRetirement.warn).not.toHaveBeenCalled();
      expect(afterRetirement.res.statusCode).toBe(200);
      expect(afterRetirement.socketDestroyed).toBe(false);
    },
  );

  it("does not transfer a route to an instance whose duplicate registration was rejected", async () => {
    const observed: Array<string | undefined> = [];
    const handler = () => {
      observed.push(getPluginRuntimeGatewayRequestScope()?.pluginId);
      return true;
    };
    const first = createOwner("accepted");
    const rejected = createOwner("rejected", first.builder);
    first.api.registerHttpRoute({ path: "/owned", auth: "plugin", handler });
    rejected.api.registerHttpRoute({ path: "/owned", auth: "plugin", handler });
    expect(first.registry.httpRoutes).toHaveLength(1);
    expect(first.registry.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ pluginId: "rejected", level: "error" })]),
    );
    await rejected.instance.dispose();

    const response = await dispatch(first.registry);
    expect(observed).toEqual(["accepted"]);
    expect(response.warn).not.toHaveBeenCalled();
    expect(response.res.statusCode).toBe(200);
  });

  it.each(["static", "dynamic", "anonymous"] as const)(
    "keeps a projected %s route's selected registry through nested managed calls",
    async (registration) => {
      const owner = createOwner();
      const observed: Array<PluginRegistry | undefined> = [];
      const nested = owner.instance.wrap(() => {
        observed.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
        return true;
      });
      if (registration === "static") {
        owner.api.registerHttpRoute({ path: "/owned", auth: "plugin", handler: () => nested() });
      } else {
        owner.instance.run(() =>
          registerPluginHttpRoute({
            registry: owner.registry,
            path: "/owned",
            auth: "plugin",
            handler: () => nested(),
            ...(registration === "dynamic" ? { pluginId: owner.record.id } : {}),
            throwOnFailure: true,
          }),
        );
      }
      const selected = createEmptyPluginRegistry();
      selected.plugins.push(owner.record);
      projectPluginContributions(owner.registry, owner.record, selected);

      const response = await dispatch(selected);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(selected);
      expect(response.warn).not.toHaveBeenCalled();
    },
  );

  it("uses the invoked upgrade callback's owner for an untracked route", async () => {
    const http = createOwner("http");
    const upgrade = createOwner("upgrade");
    const handleUpgrade = upgrade.instance.adopt(vi.fn(() => true));
    const registry = createEmptyPluginRegistry();
    registry.httpRoutes.push({
      path: "/owned",
      auth: "plugin",
      match: "exact",
      handler: http.instance.adopt(() => true),
      handleUpgrade,
    });
    await upgrade.instance.dispose();

    const response = await dispatch(registry, "WebSocket");
    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(response.socketDestroyed).toBe(true);
    expect(response.warn).toHaveBeenCalledWith(
      expect.stringContaining("Plugin upgrade was reloaded"),
    );
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
    const first = createOwner();
    const second = createOwner();
    first.api.lifecycle.onDispose!(() => {
      events.push("disposed");
    });
    for (const { api } of [first, second]) {
      api.registerHttpRoute({ path: "/owned", auth: "plugin", handler });
    }
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
    owner.instance.run(() =>
      withPluginHttpRouteRegistry(
        owner.registry,
        () =>
          registerPluginHttpRoute({
            path: "/owned",
            auth: "plugin",
            handler,
            throwOnFailure: true,
          }),
        lease,
      ),
    );
    const handoff = createPluginHttpRouteHandoff();
    handoff.park(lease);
    lease.revoke();
    await owner.instance.dispose();
    try {
      const response = await dispatch(owner.registry);
      expect(response.res.statusCode).toBe(503);
      expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
      expect(response.end).toHaveBeenCalledWith("plugin route is restarting; retry");
      expect(response.warn).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      handoff.release();
    }
  });

  it("keeps the bundled Prometheus singleton scrape live after another registration retires", async () => {
    const pluginId = "diagnostics-prometheus";
    const plugin = resolvePluginModuleExport(
      loadBundledPluginPublicArtifactModuleSync({
        dirName: pluginId,
        artifactBasename: "index.js",
      }),
    );
    expect(plugin.definition?.id).toBe(pluginId);
    const register = expectDefined(plugin.register, "Prometheus registration");
    const first = createOwner(pluginId);
    const second = createOwner(pluginId);
    for (const { api, registry, record } of [first, second]) {
      runPluginRegisterSyncInRegistry(register, api, registry, record.id);
    }
    expect(first.registry.httpRoutes[0]?.handler).toBe(second.registry.httpRoutes[0]?.handler);
    await second.instance.dispose();

    const response = await dispatch(first.registry, "HTTP", "/api/diagnostics/prometheus");
    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/plain; version=0.0.4; charset=utf-8",
    );
    expect(response.warn).not.toHaveBeenCalled();
  });
});
