import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import {
  catalogProvider as provider,
  expectCatalog,
} from "./session-catalog.fixtures.test-support.js";

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
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../state/user-profiles.js", () => ({
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
}));
vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
  readResidentUserProfileAliases: (id: string) => new Set([id]),
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");
let projection: ReturnType<typeof createSessionRowProjectionFixture>;

async function listCatalogs(providers: SessionCatalogProvider[], params: unknown = {}) {
  hoisted.activeRegistry.sessionCatalogs = providers.map((entry) => ({ provider: entry }));
  const respond = vi.fn();
  await sessionCatalogHandlers["sessions.catalog.list"]?.({
    params,
    respond,
    context: bindSessionRowProjection({ getRuntimeConfig: () => ({}) }, () => projection),
  } as never);
  return respond;
}

describe("session catalog share routes", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
    hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
    projection = createSessionRowProjectionFixture({ cfg: {}, store: {} });
  });
  afterEach(() => projection.dispose());

  it("projects uniquely owned routes and suppresses collisions", async () => {
    expectCatalog(
      await listCatalogs([provider("external", { shareRoute: SHARE_ROUTE })], {
        catalogId: "external",
      }),
      { shareRoute: SHARE_ROUTE },
    );
    const collisions = await listCatalogs(
      ["first", "second"].map((id) => provider(id, { shareRoute: SHARE_ROUTE })),
    );
    const { catalogs } = collisions.mock.calls[0]![1] as {
      catalogs: Array<{ shareRoute?: unknown }>;
    };
    expect(catalogs.every((catalog) => catalog.shareRoute === undefined)).toBe(true);
  });

  it("does not project a reserved route", async () => {
    const respond = await listCatalogs(
      [provider("external", { shareRoute: { ...SHARE_ROUTE, routeSegment: "chat" } })],
      { catalogId: "external" },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.not.objectContaining({ shareRoute: expect.anything() })],
    });
  });
});
