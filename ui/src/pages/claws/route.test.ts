/* @vitest-environment jsdom */

import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createChangeListeners } from "../../../../src/shared/listeners.ts";
import { createApplicationRouter, startApplicationRouter } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { ClawsPage } from "./page.tsx";

async function setup(pathname: string, initialConfig: Record<string, unknown> | null = null) {
  const source = createApplicationGateway();
  let bootstrapConfig = initialConfig;
  const configListeners = createChangeListeners();
  const runtimeConfig = createRuntimeConfigCapability(source.gateway, {
    current: () => bootstrapConfig,
    subscribe: configListeners.subscribe,
  });
  const context = {
    basePath: "",
    gateway: source.gateway,
    runtimeConfig,
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  let location: RouteLocation = { pathname, search: "", hash: "" };
  const writeHistory = (next: RouteLocation) => {
    location = next;
  };
  const history: RouterHistory = {
    location: () => location,
    push: writeHistory,
    replace: writeHistory,
    listen: () => () => undefined,
  };
  const router = createApplicationRouter();
  onTestFinished(() => {
    router.stop();
    runtimeConfig.dispose();
  });
  await startApplicationRouter(router, history, "", context);
  return {
    ...source,
    context,
    router,
    history,
    publishConfig: (config: Record<string, unknown>) => {
      bootstrapConfig = config;
      configListeners.publish();
    },
  };
}

function clawsConfig(enabled: boolean) {
  return { gateway: { controlUi: { experimental: { claws: enabled } } } };
}

it("rejects a direct visit when Claws is known-disabled", async () => {
  const fixture = await setup("/claws/workflow-operator", clawsConfig(false));
  expect(fixture.router.getState().matches[0]?.status).toBe("notFound");
});

it.each([
  ["/claws", true],
  ["/claws/workflow-operator", false],
] as const)("gates cold %s until Labs=%s", async (pathname, enabled) => {
  const fixture = await setup(pathname);
  expect(fixture.router.getState().matches[0]).toMatchObject({
    routeId: "claws",
    status: "success",
    data: { location: { pathname } },
  });
  const view = mountSolid(
    () =>
      createComponent(ClawsPage, {
        routeData: { basePath: "", location: fixture.history.location() },
      }),
    { wrapper: createSolidApplicationContextProvider(fixture.context).wrapper },
  );
  const loading = () => view.container.querySelector(".plugin-catalog-detail--loading");
  const explore = () => view.container.querySelector("[data-claws-explore]");
  expect(loading()).not.toBeNull();
  expect(view.container.textContent).not.toContain("Claws is disabled");
  expect(explore()).toBeNull();

  const request = vi.fn(async () => ({ entries: [] }));
  fixture.publishConfig(clawsConfig(enabled));
  fixture.publish({
    ...fixture.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
    hello: gatewayHelloForMethods(["claws.catalog.search"], ["operator.read"]),
  });
  await vi.waitFor(() => expect(loading()).toBeNull());
  await vi.waitFor(() => expect(explore() !== null).toBe(enabled));
  if (!enabled) {
    expect(view.container.textContent).toContain("Claws is disabled");
    expect(request).not.toHaveBeenCalled();
  }
  expect(fixture.history.location().pathname).toBe(pathname);
});
