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
