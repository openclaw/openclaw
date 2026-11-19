/* @vitest-environment jsdom */
import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApplicationRouter, startApplicationRouter } from "../../app-routes.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "../agents-home/agents-home-page.test-helpers.ts";
import { beginTemplateDetailRead } from "./detail-read.ts";
import { TemplatesPage } from "./page.tsx";
import { page, type TemplatesRouteData } from "./route.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);
const location = {
  pathname: "/templates/packages/%40openclaw%2Fworkflow-operator",
  search: "?version=1.2.0",
  hash: "",
};

it("dispatches an admitted detail before mounting, and a remount joins the same live request", async () => {
  const { context, request, wrapper, unmountPage } = createPage({ templatesEnabled: true });
  unmountPage();
  const original = request.getMockImplementation()!;
  const reply = Promise.withResolvers<unknown>();
  request.mockImplementation((method, params, options) =>
    method === "templates.catalog.detail" ? reply.promise : original(method, params, options),
  );
  const detailCalls = () =>
    request.mock.calls.filter(([method]) => method === "templates.catalog.detail");
  const deps = page.loaderDeps!(context, location);
  await page.loader!(context, createRouteLoaderOptions(location, deps, "preload"));
  expect(detailCalls()).toHaveLength(0);
  const data = await page.loader!(context, createRouteLoaderOptions(location, deps));
  expect(detailCalls().map(([, params]) => params)).toEqual([
    { packageName: workflowOperator.packageName, version: "1.2.0" },
  ]);
  if (!data || !("basePath" in data)) {
    throw new Error("Missing Templates route data");
  }
  const mountPage = (routeData: TemplatesRouteData) =>
    mountSolid(() => createComponent(TemplatesPage, { routeData }), { wrapper });
  const first = mountPage(data);
  await waitForSolid(() =>
    expect(first.container.querySelector(".plugin-catalog-detail--loading")).not.toBeNull(),
  );
  first.unmount();
  const second = mountPage(data);
  reply.resolve(await original("templates.catalog.detail", {}));
  await waitForSolid(() =>
    expect(second.container.querySelector(".plugin-capabilities")).not.toBeNull(),
  );
  expect(detailCalls()).toHaveLength(1);
  second.unmount();
  // A revisit still checks the live Gateway, not a cached release receipt.
  const revisit = await page.loader!(context, createRouteLoaderOptions(location, deps));
  if (!revisit || !("basePath" in revisit)) {
    throw new Error("Missing Templates route data");
  }
  const mountOnce = mountPage(revisit);
  await waitForSolid(() =>
    expect(mountOnce.container.querySelector(".plugin-capabilities")).not.toBeNull(),
  );
  expect(detailCalls()).toHaveLength(2);
  mountOnce.unmount();
});

it("reads once across the bridged document startup, then once on a fresh revisit", async () => {
  const { context, request, unmountPage } = createPage({ templatesEnabled: true });
  unmountPage();
  request.mockClear();
  const router = createApplicationRouter();
  let current: RouteLocation = location;
  const write = (next: RouteLocation) => {
    current = next;
  };
  const history = { location: () => current, push: write, replace: write, listen: () => () => {} };
  const calls = () => request.mock.calls.filter(([method]) => method.startsWith("templates."));
  const detail = [
    "templates.catalog.detail",
    { packageName: workflowOperator.packageName, version: "1.2.0" },
  ];
  try {
    await startApplicationRouter(router, history, "", context);
    expect(calls()).toEqual([detail]);
    await router.navigate(
      "templates",
      context,
      {},
      { ...location, pathname: "/templates", search: "" },
    );
    await router.navigate("templates", context, {}, location);
    expect(calls()).toEqual([detail, detail]);
  } finally {
    router.stop();
  }
});

it("does not dispatch a detail for draft, directory, retired navigation, or disconnected entries", async () => {
  const { context, request, setPhase, unmountPage } = createPage({ templatesEnabled: true });
  unmountPage();
  request.mockClear();
  for (const candidate of [
    { ...location, search: "?agent=helper&draft=mine" },
    { ...location, search: "?create=helper" },
    { ...location, pathname: "/templates" },
  ]) {
    await page.loader!(context, createRouteLoaderOptions(candidate));
  }
  await page.loader!(context, { ...createRouteLoaderOptions(location), shouldRun: () => false });
  await page.loader!(context, {
    ...createRouteLoaderOptions(location),
    signal: AbortSignal.abort(),
  });
  setPhase("reconnecting");
  await page.loader!(context, createRouteLoaderOptions(location));
  expect(request.mock.calls.filter(([method]) => method.startsWith("templates."))).toEqual([]);
});

it("starts another read for a changed package or version while an earlier read is pending", async () => {
  const { context, request, unmountPage } = createPage({ templatesEnabled: true });
  unmountPage();
  const reply = Promise.withResolvers<unknown>();
  request.mockImplementation(() => reply.promise);
  for (const candidate of [
    location,
    { ...location, search: "?version=1.3.0" },
    { ...location, pathname: "/templates/packages/second-package", search: "" },
  ]) {
    await page.loader!(context, createRouteLoaderOptions(candidate));
  }
  expect(
    request.mock.calls
      .filter(([method]) => method === "templates.catalog.detail")
      .map(([, params]) => params),
  ).toEqual([
    { packageName: workflowOperator.packageName, version: "1.2.0" },
    { packageName: workflowOperator.packageName, version: "1.3.0" },
    { packageName: "second-package" },
  ]);
  reply.reject(new Error("navigation abandoned"));
});

it("rejects a prepared read after loss of access or an identity change on the same client", () => {
  const reply = Promise.withResolvers<unknown>();
  const request = vi.fn(() => reply.promise);
  const { gateway, publish } = createApplicationGateway();
  const hello = gatewayHelloForMethods(["templates.catalog.detail"], ["operator.read"]);
  const connected = {
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected" as const,
    hello,
    selfUser: { id: "first" },
  };
  publish(connected);
  const source = { packageName: workflowOperator.packageName };
  const first = beginTemplateDetailRead(gateway, source);
  expect(first).toBeDefined();
  expect(beginTemplateDetailRead(gateway, source)).toBe(first);
  for (const denied of [
    gatewayHelloForMethods([], ["operator.read"]),
    gatewayHelloForMethods(["templates.catalog.detail"], []),
  ]) {
    publish({ ...connected, hello: denied });
    expect(beginTemplateDetailRead(gateway, source, { prepared: first })).toBeUndefined();
  }
  publish({ ...connected, selfUser: { id: "second" } });
  expect(beginTemplateDetailRead(gateway, source, { prepared: first })).not.toBe(first);
  publish({ ...gateway.snapshot, hello: { ...hello } });
  beginTemplateDetailRead(gateway, source, { prepared: first });
  expect(request).toHaveBeenCalledTimes(3);
  reply.reject(new Error("retired"));
});
