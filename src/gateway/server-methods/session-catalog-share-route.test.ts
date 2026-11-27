import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionCatalogShareRoute } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { catalogProvider } from "./session-catalog.fixtures.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider; pluginId?: string }>;
};

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "shared-sessions",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const satisfies NonNullable<SessionCatalogProvider["shareRoute"]>;

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: () => false,
  readResidentUserProfileAliases: (id: string) => new Set([id]),
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");
let projection: ReturnType<typeof createSessionRowProjectionFixture>;

async function listRoutes(ids: string[], routeSegment = "shared-sessions") {
  hoisted.activeRegistry.sessionCatalogs = ids.map((id) => ({
    provider: catalogProvider(id, { shareRoute: { ...SHARE_ROUTE, routeSegment } }),
  }));
  const respond = vi.fn();
  await sessionCatalogHandlers["sessions.catalog.list"]?.({
    params: ids.length === 1 ? { catalogId: ids[0] } : {},
    respond,
    context: bindSessionRowProjection({ getRuntimeConfig: () => ({}) }, () => projection),
  } as never);
  expect(respond.mock.calls[0]![0]).toBe(true);
  const { catalogs } = respond.mock.calls[0]![1] as {
    catalogs: Array<{ shareRoute?: SessionCatalogShareRoute }>;
  };
  return catalogs.map(({ shareRoute }) => shareRoute);
}

beforeEach(() => {
  hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
  markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
  projection = createSessionRowProjectionFixture({ cfg: {}, store: {} });
});
afterEach(() => projection.dispose());

it("projects uniquely owned routes and suppresses collisions", async () => {
  expect(await listRoutes(["external"])).toEqual([SHARE_ROUTE]);
  expect(await listRoutes(["first", "second"])).toEqual([undefined, undefined]);
});

it("does not project a reserved route", async () => {
  expect(await listRoutes(["external"], "chat")).toEqual([undefined]);
});

it("resolves a cold route against this caller's read and write scopes", async () => {
  const ownedRouteMethods = {
    list: "notebook.mine.list",
    read: "notebook.mine.read",
    resolve: "notebook.mine.resolve",
    continue: "notebook.mine.continue",
  };
  const provider = catalogProvider("notebook-catalog", {
    shareRoute: SHARE_ROUTE,
    ownedRoute: { methods: ownedRouteMethods, requiredGrantPluginId: "guest-access" },
    copyToGatewaySession: async () => ({}),
  });
  hoisted.activeRegistry.sessionCatalogs = [{ provider, pluginId: "notebook" }];
  const registry = createGatewayMethodRegistry(
    [
      ...(["list", "read", "resolve", "continue"] as const).map((op) => ({
        name: `sessions.catalog.${op}`,
        scope: op === "continue" ? ("operator.write" as const) : ("operator.read" as const),
        owner: { kind: "core" as const, area: "session-catalog" },
        handler: () => {},
      })),
      ...Object.values(ownedRouteMethods).map((name) => ({
        name,
        scope: "operator.sessions.write" as const,
        owner: { kind: "plugin" as const, pluginId: "notebook" },
        handler: () => {},
      })),
      {
        name: "notebook.readOnly",
        scope: "operator.sessions.read",
        owner: { kind: "plugin", pluginId: "notebook" },
        handler: () => {},
      },
    ],
    hoisted.activeRegistry as PluginRegistry,
  );
  const resolve = async (
    scopes: string[],
    params: Record<string, unknown>,
    identified = true,
    issuer = "guest-access",
    signal = new AbortController().signal,
  ) => {
    const respond = vi.fn<RespondFn>();
    const client = {
      connect: { scopes },
      ...(identified ? { authenticatedUserProfile: { profileId: "reader" } } : {}),
      internal: {
        operatorAccessAuthority: {
          requiredPolicyPlugin: issuer,
          // A composed authority has no singular durable recovery grant.
          signal,
          assertCurrent() {},
        },
      },
    } as unknown as GatewayClient;
    await sessionCatalogHandlers["sessions.catalog.route"]?.({
      req: { type: "req", id: "catalog-route", method: "sessions.catalog.route" },
      params,
      respond,
      client,
      isWebchatConnect: () => false,
      context: { getGatewayMethodRegistry: () => registry } as GatewayRequestContext,
    });
    return respond.mock.calls[0];
  };
  const lookup = { routeSegment: SHARE_ROUTE.routeSegment };
  const byId = { catalogId: provider.id };
  const base = { catalogId: provider.id, ...lookup };
  expect(await resolve(["operator.sessions.write"], lookup)).toEqual([
    true,
    { ...base, methods: ownedRouteMethods },
  ]);
  expect(await resolve(["operator.read", "operator.sessions.write"], byId)).toEqual([
    true,
    {
      ...base,
      methods: {
        ...ownedRouteMethods,
        list: "sessions.catalog.list",
        read: "sessions.catalog.read",
      },
    },
  ]);
  expect(await resolve(["operator.read"], lookup)).toEqual([
    true,
    { ...base, methods: { list: "sessions.catalog.list", read: "sessions.catalog.read" } },
  ]);
  expect(await resolve(["operator.sessions.write"], lookup, true, "unrelated")).toEqual([
    true,
    null,
  ]);
  expect(
    await resolve(["operator.sessions.write"], lookup, true, "guest-access", AbortSignal.abort()),
  ).toEqual([true, null]);
  expect(await resolve(["operator.sessions.read"], lookup)).toEqual([true, null]);
  expect(await resolve(["operator.sessions.write"], lookup, false)).toEqual([true, null]);
  expect(await resolve(["operator.sessions.write"], { routeSegment: "unknown" })).toEqual([
    true,
    null,
  ]);
  expect((await resolve(["operator.read"], { ...lookup, ...byId }))?.[0]).toBe(false);
  ownedRouteMethods.continue = "notebook.readOnly";
  expect(await resolve(["operator.sessions.write"], lookup)).toEqual([
    true,
    {
      ...base,
      methods: {
        list: ownedRouteMethods.list,
        read: ownedRouteMethods.read,
        resolve: ownedRouteMethods.resolve,
      },
    },
  ]);
  hoisted.activeRegistry.sessionCatalogs = [{ provider, pluginId: "another-plugin" }];
  expect(await resolve(["operator.sessions.write"], lookup)).toEqual([true, null]);
  expect(provider.list).not.toHaveBeenCalled();
  expect(provider.read).not.toHaveBeenCalled();
});
