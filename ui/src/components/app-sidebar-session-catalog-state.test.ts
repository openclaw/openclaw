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

it.each([
  ["host", "DISCOVERY_TRUNCATED"],
  ["catalog", "DISCOVERY_TRUNCATED"],
  ["host", "FILTER_PARTIAL"],
] as const)(
  "retains a partial final page with a %s %s warning through pagination and refresh",
  async (warningScope, code) => {
    const first = catalog(["first"], { nextCursor: "retry" });
    const error = { code, message: "Partial results; check the source." };
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

it("publishes fresh authorized fallback rows instead of wiping a fresh-list catalog", async () => {
  const fresh = {
    ...catalog(["authorized"], {
      error: { code: "FILTER_PARTIAL", message: "Client-side matching" },
    }),
    requiresFreshList: true as const,
  };
  const result = await refetchExpandedSessionCatalogPages({
    catalogs: [fresh],
    previousCatalogs: [catalog(["previous"])],
    client: createTestGatewayClient(async () => {
      throw new Error("Unexpected refetch");
    }),
    agentId: "main",
    pageDepths: new Map(),
    isCurrent: () => true,
    canRequestPage: () => true,
  });
  expect(result[0]?.hosts[0]?.sessions.map(({ threadId }) => threadId)).toEqual(["authorized"]);
  expect(result[0]?.hosts[0]?.error?.code).toBe("FILTER_PARTIAL");
});
