import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { readCatalogRoute } from "./catalog-read-method.ts";

const selector = { catalogId: "notebook" };
const readMethods = {
  list: "sessions.catalog.list",
  read: "sessions.catalog.read",
  resolve: "sessions.catalog.resolve",
};

it("uses the caller's operation map for a cold link", async () => {
  const route = {
    ...selector,
    routeSegment: "notes",
    methods: { ...readMethods, continue: "notebook.owner.copy" },
  };
  const request = vi.fn().mockResolvedValue(route);
  const hello = gatewayHelloForMethods(
    ["sessions.catalog.route"],
    ["operator.read", "operator.sessions.write"],
  );
  const signal = new AbortController().signal;
  expect(await readCatalogRoute({ request }, { hello }, { routeSegment: "notes" }, signal)).toEqual(
    route,
  );
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "sessions.catalog.route",
    { routeSegment: "notes" },
    { signal },
  );
});

it.each([
  { scopes: ["operator.sessions.write"], methods: null },
  { scopes: ["operator.read"], methods: readMethods },
  {
    scopes: ["operator.write"],
    methods: { ...readMethods, continue: "sessions.catalog.continue" },
  },
])("preserves shared access to ordinary catalogs for $scopes", async ({ scopes, methods }) => {
  const request = vi.fn().mockResolvedValue(null);
  const hello = gatewayHelloForMethods(["sessions.catalog.route"], scopes);
  const client: Pick<GatewayBrowserClient, "request"> = { request };
  expect(await readCatalogRoute(client, { hello }, selector)).toEqual(methods && { methods });
  expect(await readCatalogRoute(client, { hello }, { routeSegment: "unknown" })).toBeNull();
});
