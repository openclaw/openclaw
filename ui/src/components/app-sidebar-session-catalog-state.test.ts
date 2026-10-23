import { expect, it } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
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

it("retains truncated final-page rows and warning through pagination and expanded refresh", async () => {
  const first = catalog(["first"], { nextCursor: "last-page" });
  const error = { code: "DISCOVERY_TRUNCATED", message: "Search by exact session ID." };
  const last = catalog(["last"], { error });
  const merged = mergeSessionCatalogPage({
    current: first,
    page: last,
    cursors: { "gateway:local": "last-page" },
  });
  expect(merged.advancedHostIds).toEqual(["gateway:local"]);
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
    expect(host?.error).toEqual(error);
  }
});
