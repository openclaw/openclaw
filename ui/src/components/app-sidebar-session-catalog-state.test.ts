import { expect, it } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.ts";
import {
  createTestGatewayClient,
  createGatewayRequestMock,
} from "../test-helpers/gateway-client.ts";
import {
  mergeSessionCatalogPage,
  refetchExpandedSessionCatalogPages,
} from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

function catalog(ids: string[], details: Partial<SessionCatalogHost> = {}): SessionCatalog {
  return {
    id: "anthropic",
    label: "Claude Code",
    capabilities: { continueSession: true, archive: false },
    hosts: [
      {
        hostId: "gateway:local",
        label: "Local Claude",
        kind: "gateway",
        connected: true,
        sessions: ids.map((threadId) => ({
          threadId,
          status: "stored",
          archived: false,
          canContinue: true,
          canArchive: false,
        })),
        ...details,
      },
    ],
  };
}

it.each(["host", "catalog"] as const)(
  "retains a truncated final page with a %s warning through pagination and refresh",
  async (warningScope) => {
    const first = catalog(["first"], { nextCursor: "retry" });
    const error = { code: "DISCOVERY_TRUNCATED", message: "Search by exact session ID." };
    const last = catalog(["last"], warningScope === "host" ? { error } : {});
    if (warningScope === "catalog") {
      last.error = error;
    }
    const merged = mergeSessionCatalogPage({
      current: first,
      page: last,
      cursors: { "gateway:local": "retry" },
    });
    expect.soft(merged.advancedHostIds).toEqual(["gateway:local"]);
    const refreshed = await refetchExpandedSessionCatalogPages({
      catalogs: [first],
      previousCatalogs: [catalog(["first", "stale"])],
      client: createTestGatewayClient(async () => ({ catalogs: [last] })),
      agentId: "main",
      pageDepths: new Map([[sessionCatalogHostKey("anthropic", "gateway:local"), 1]]),
      isCurrent: () => true,
      canRequestPage: () => true,
    });
    for (const result of [merged.catalog, refreshed[0]]) {
      const host = result?.hosts[0];
      expect(host?.sessions.map((row) => row.threadId)).toEqual(["first", "last"]);
      expect(host?.nextCursor).toBeUndefined();
      expect(result?.error ?? host?.error).toEqual(error);
    }
  },
);

it("replays expanded pages with the owning poll scope and only supported relationship queries", async () => {
  const first = catalog(["first"], { nextCursor: "native-next" });
  const shared = {
    ...catalog(["shared-first"], { nextCursor: "selected-next" }),
    id: "openclaw",
    capabilities: { continueSession: false, archive: false, profileRelation: true as const },
  };
  const query = {
    relationship: "owned" as const,
    target: { type: "local-profile" as const, id: "local-person" },
  };
  const request = createGatewayRequestMock(async (_method, args) => ({
    catalogs: [{ ...catalog(["last"]), id: (args as { catalogId: string }).catalogId }],
  }));
  await refetchExpandedSessionCatalogPages({
    catalogs: [first, shared],
    previousCatalogs: [],
    client: createTestGatewayClient(request),
    agentId: "main",
    pollId: "sidebar",
    profileRelation: query,
    pageDepths: new Map(
      [first, shared].map((entry) => [sessionCatalogHostKey(entry.id, "gateway:local"), 1]),
    ),
    isCurrent: () => true,
    canRequestPage: () => true,
  });
  expect(request).toHaveBeenCalledWith(
    "sessions.catalog.list",
    expect.objectContaining({
      catalogId: "openclaw",
      pollId: "sidebar",
      profileRelation: query,
      cursors: { "gateway:local": "selected-next" },
    }),
  );
  expect(
    request.mock.calls.find(
      ([, args]) => (args as { catalogId: string }).catalogId === "anthropic",
    )?.[1],
  ).not.toHaveProperty("profileRelation");
});
