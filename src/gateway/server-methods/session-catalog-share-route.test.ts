import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionCatalogShareRoute } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { catalogProvider } from "./session-catalog.fixtures.test-support.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
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
