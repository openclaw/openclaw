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

function setup(pathname: string, initialConfig: Record<string, unknown> | null = null) {
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
  const writeHistory = vi.fn((next: RouteLocation) => {
    location = next;
  });
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
  return {
    ...source,
    context,
    router,
    history,
    writeHistory,
    publishConfig: (config: Record<string, unknown>) => {
      bootstrapConfig = config;
      configListeners.publish();
    },
    start: () => startApplicationRouter(router, history, "", context),
  };
}

function clawsConfig(enabled: boolean) {
  return { gateway: { controlUi: { experimental: { claws: enabled } } } };
}

it.each([
  ["/claws", null],
  ["/claws/workflow-operator", null],
  ["/claws", false],
  ["/claws/workflow-operator", false],
] as const)("routes %s with initial Labs flag %s", async (pathname, enabled) => {
  const fixture = setup(pathname, enabled === null ? null : clawsConfig(enabled));
  await fixture.start();
  if (enabled === false) {
    expect(fixture.router.getState().matches[0]?.status).toBe("notFound");
  } else {
    expect(fixture.router.getState().matches[0]).toMatchObject({
      routeId: "claws",
      status: "success",
      data: { location: { pathname } },
    });
    fixture.publishConfig(clawsConfig(true));
    expect(fixture.history.location().pathname).toBe(pathname);
    expect(fixture.writeHistory).not.toHaveBeenCalled();
  }
});

it.each([true, false])(
  "keeps discovery unavailable until a cold visit learns the Labs flag is %s",
  async (enabled) => {
    const fixture = setup("/claws");
    await fixture.start();
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
    if (enabled) {
      await vi.waitFor(() => expect(request).toHaveBeenCalled());
      expect(explore()).not.toBeNull();
    } else {
      expect(view.container.textContent).toContain("Claws is disabled");
      expect(explore()).toBeNull();
      expect(request).not.toHaveBeenCalled();
    }
    expect(fixture.history.location().pathname).toBe("/claws");
  },
);
