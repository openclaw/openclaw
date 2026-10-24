import { expect, onTestFinished } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
} from "./plugins-page.test-support.ts";

export function queryWithin(root: ParentNode) {
  return root.querySelector.bind(root);
}

function createFixture<Context extends ApplicationContext>(
  handlers: Record<string, (params: unknown) => unknown>,
  makeContext: (gateway: ReturnType<typeof createGateway>["gateway"]) => Context,
) {
  const { client, request } = createClient(async (method, params) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler(params);
  });
  const harness = createGateway(client);
  const context = makeContext(harness.gateway);
  const route = (path: string, result = createResult()) =>
    createPluginsRouteData(harness.gateway, result, createPluginsRouteLocation(path));
  const calls = (name: string) => request.mock.calls.filter(([method]) => method === name);
  return {
    ...harness,
    client,
    request,
    context,
    route,
    calls,
    async mount(path = "/settings/plugins/workboard", result = createResult()) {
      const { page } = await mountPage(context, route(path, result));
      return { page, find: queryWithin(page) };
    },
    publishGeneration(generation: number, methods: string[] = []) {
      harness.emit(harness.gateway.snapshot.client, true, {
        hello: harness.gateway.snapshot.hello,
        pluginCapabilities: {
          ok: true,
          generation,
          descriptors: [],
          methods,
          controlUiTabs: [],
          controlUiWidgetKinds: [],
          pluginSurfaceUrls: {},
        },
      });
    },
    waitForCall: (name: string) =>
      waitForSolid(() => expect(calls(name).length).toBeGreaterThan(0)),
  };
}

export function pageFixture(
  handlers: Parameters<typeof createFixture>[0],
  refresh?: ApplicationContext["runtimeConfig"]["refresh"],
) {
  return createFixture(handlers, (gateway) => createContext(gateway, refresh));
}

export function runtimeFixture(handlers: Parameters<typeof createFixture>[0]) {
  const fixture = createFixture(handlers, (gateway) => {
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    onTestFinished(() => runtimeConfig.dispose());
    return { ...createContext(gateway), runtimeConfig };
  });
  return { ...fixture, runtimeConfig: fixture.context.runtimeConfig };
}
