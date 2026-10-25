import { expect, it, vi } from "vitest";
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
  { pendingScope: "host", recoveredIds: ["recovered"] },
  { pendingScope: "host", recoveredIds: [] },
  { pendingScope: "catalog", recoveredIds: ["recovered"] },
  { pendingScope: "catalog", recoveredIds: [] },
] as const)(
  "retains rows and recovers a pending $pendingScope page with $recoveredIds",
  async ({ pendingScope, recoveredIds }) => {
    const error = { code: "UNAVAILABLE", message: "Previous page failed" };
    const previous = catalog(["first", "expanded"], { nextCursor: "retry", error });
    const pending = catalog([], { pending: true });
    if (pendingScope === "catalog") {
      pending.pending = true;
      pending.hosts = [];
    }
    const merged = mergeSessionCatalogPage({
      current: previous,
      page: pending,
      cursors: { "gateway:local": "retry" },
    });
    expect.soft(merged.advancedHostIds).toEqual([]);
    expect(merged.repeatedHostIds).toEqual([]);
    const request = vi.fn(async () => ({ catalogs: [pending] }));
    const refreshed = await refetchExpandedSessionCatalogPages({
      catalogs: [catalog(["fresh"], { nextCursor: "retry" })],
      previousCatalogs: [previous],
      client: createTestGatewayClient(request),
      agentId: "main",
      pageDepths: new Map([[sessionCatalogHostKey("anthropic", "gateway:local"), 2]]),
      isCurrent: () => true,
      canRequestPage: () => true,
    });
    expect(request).toHaveBeenCalledTimes(1);
    for (const result of [merged.catalog, refreshed[0]]) {
      expect.soft(result?.hosts[0]).toMatchObject({
        pending: true,
        nextCursor: "retry",
        error,
      });
      expect(result?.hosts[0]?.sessions.map((row) => row.threadId)).toEqual(["first", "expanded"]);
    }
    const failed = catalog([], pendingScope === "host" ? { error } : {});
    if (pendingScope === "catalog") {
      failed.error = error;
      failed.hosts = [];
    }
    const rejected = mergeSessionCatalogPage({
      current: merged.catalog,
      page: failed,
      cursors: { "gateway:local": "retry" },
    });
    expect(rejected.catalog.hosts[0]?.pending).not.toBe(true);
    expect(rejected.catalog.pending).not.toBe(true);
    expect(rejected.catalog.hosts[0]?.sessions).toEqual(previous.hosts[0]?.sessions);
    const retrying = mergeSessionCatalogPage({
      current: rejected.catalog,
      page:
        pendingScope === "host"
          ? catalog([], { error, pending: true })
          : { ...failed, pending: true },
      cursors: { "gateway:local": "retry" },
    });
    expect(retrying.catalog.hosts[0]?.pending).toBe(true);
    expect(retrying.catalog.error ?? retrying.catalog.hosts[0]?.error).toEqual(error);
    const recovered = mergeSessionCatalogPage({
      current: retrying.catalog,
      page: catalog([...recoveredIds]),
      cursors: { "gateway:local": "retry" },
    });
    expect(recovered.catalog.hosts[0]?.sessions.map((row) => row.threadId)).toEqual([
      "first",
      "expanded",
      ...recoveredIds,
    ]);
    expect(recovered.catalog.pending).toBeUndefined();
    expect(recovered.catalog.hosts[0]?.pending).toBeUndefined();
    expect(recovered.catalog.hosts[0]?.error).toBeUndefined();
    expect(recovered.catalog.hosts[0]?.nextCursor).toBeUndefined();
  },
);

it.each(["host", "catalog"] as const)(
  "retains a truncated final page with a %s warning through pagination and refresh",
  async (warningScope) => {
    const first = catalog(["first"], { nextCursor: "last-page" });
    const error = { code: "DISCOVERY_TRUNCATED", message: "Search by exact session ID." };
    const last = catalog(["last"], warningScope === "host" ? { error } : {});
    if (warningScope === "catalog") {
      last.error = error;
    }
    const merged = mergeSessionCatalogPage({
      current: first,
      page: last,
      cursors: { "gateway:local": "last-page" },
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
