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

const cursors = { "gateway:local": "retry" };
const merge = (current: SessionCatalog, page: SessionCatalog) =>
  mergeSessionCatalogPage({ current, page, cursors });
const refresh = (
  current: SessionCatalog,
  previous: SessionCatalog,
  page: SessionCatalog,
  depth: number,
) => {
  const request = vi.fn(async () => ({ catalogs: [page] }));
  return {
    request,
    result: refetchExpandedSessionCatalogPages({
      catalogs: [current],
      previousCatalogs: [previous],
      client: createTestGatewayClient(request),
      agentId: "main",
      pageDepths: new Map([[sessionCatalogHostKey("anthropic", "gateway:local"), depth]]),
      isCurrent: () => true,
      canRequestPage: () => true,
    }),
  };
};

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
    const merged = merge(previous, pending);
    expect(merged).toMatchObject({ advancedHostIds: [], repeatedHostIds: [] });
    const { request, result: refreshing } = refresh(
      catalog(["fresh"], { nextCursor: "retry" }),
      previous,
      pending,
      2,
    );
    const refreshed = await refreshing;
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
    const rejected = merge(merged.catalog, failed);
    expect(rejected.catalog.hosts[0]?.pending).not.toBe(true);
    expect(rejected.catalog.pending).not.toBe(true);
    expect(rejected.catalog.hosts[0]?.sessions).toEqual(previous.hosts[0]?.sessions);
    const retrying = merge(
      rejected.catalog,
      pendingScope === "host"
        ? catalog([], { error, pending: true })
        : { ...failed, pending: true },
    );
    expect(retrying.catalog.hosts[0]?.pending).toBe(true);
    expect(retrying.catalog.error ?? retrying.catalog.hosts[0]?.error).toEqual(error);
    const recovered = merge(retrying.catalog, catalog([...recoveredIds]));
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
    const first = catalog(["first"], { nextCursor: "retry" });
    const error = { code: "DISCOVERY_TRUNCATED", message: "Search by exact session ID." };
    const last = catalog(["last"], warningScope === "host" ? { error } : {});
    if (warningScope === "catalog") {
      last.error = error;
    }
    const merged = merge(first, last);
    expect.soft(merged.advancedHostIds).toEqual(["gateway:local"]);
    const refreshed = await refresh(first, catalog(["first", "stale"]), last, 1).result;
    for (const result of [merged.catalog, refreshed[0]]) {
      const host = result?.hosts[0];
      expect(host?.sessions.map((row) => row.threadId)).toEqual(["first", "last"]);
      expect(host?.nextCursor).toBeUndefined();
      expect(result?.error ?? host?.error).toEqual(error);
    }
  },
);
