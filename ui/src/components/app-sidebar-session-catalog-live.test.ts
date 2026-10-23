// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import { refetchExpandedSessionCatalogPages } from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

const idleSession = { status: "idle", archived: false, canContinue: true, canArchive: true };
function catalog(id: string, hostCount: number): SessionCatalog {
  return {
    id,
    label: id,
    capabilities: { continueSession: true, archive: true },
    hosts: Array.from({ length: hostCount }, (_, hostIndex) => ({
      hostId: `${id}-host-${hostIndex}`,
      label: `Host ${hostIndex}`,
      kind: "node",
      connected: true,
      sessions: [{ ...idleSession, threadId: `${id}-thread-${hostIndex}` }],
    })),
  };
}

let live: SessionCatalogLiveState;
let progressId: string;
beforeEach(() => {
  live = new SessionCatalogLiveState();
  progressId = live.beginRequest(1).progressId;
});
function apply(
  incoming: SessionCatalog,
  catalogs: SessionCatalog[],
  pages = new Map<string, number>(),
) {
  return live.applyHost({
    payload: { progressId, agentId: "main", catalog: incoming },
    agentId: "main",
    catalogs,
    pageDepths: pages,
  });
}

it("retains failure status while pending and applies catalog pending changes", () => {
  const current = catalog("codex", 1);
  current.hosts[0]!.error = { code: "NODE_INVOKE_FAILED", message: "Fixture node failed" };
  current.error = { code: "catalog_stale", message: "Last enumeration failed" };
  const pending = apply(
    { ...catalog("codex", 1), pending: true, hosts: [{ ...current.hosts[0]!, pending: true }] },
    [current],
  );
  expect(pending?.catalogs[0]?.pending).toBe(true);
  expect(pending?.catalogs[0]?.error).toEqual(current.error);
  expect(pending?.catalogs[0]?.hosts[0]).toMatchObject({
    pending: true,
    error: { code: "NODE_INVOKE_FAILED" },
  });

  const recovered = apply(catalog("codex", 1), pending!.catalogs);
  expect(recovered?.catalogs[0]).not.toHaveProperty("pending");
  expect(recovered?.catalogs[0]).not.toHaveProperty("error");
  expect(recovered?.catalogs[0]?.hosts[0]).not.toHaveProperty("error");
});

it.each(["final", "incremental"] as const)(
  "retains rows and cursors for a pending host in %s publications",
  async (publication) => {
    const current = catalog("codex", 2);
    current.hosts[0]!.nextCursor = "next-page";
    const pending = { ...current.hosts[0]!, pending: true, sessions: [], nextCursor: undefined };
    const incoming = { ...current, hosts: [pending] };
    const catalogs =
      publication === "final"
        ? live.mergeFinal([incoming], [current])
        : apply(incoming, [current])!.catalogs;
    expect(catalogs[0]?.hosts[0]).toMatchObject({
      pending: true,
      sessions: current.hosts[0]!.sessions,
      nextCursor: "next-page",
    });
    // A final response still removes genuinely absent hosts.
    expect(catalogs[0]?.hosts).toHaveLength(publication === "final" ? 1 : 2);
    const request = vi.fn();
    expect(
      await refetchExpandedSessionCatalogPages({
        catalogs,
        previousCatalogs: [current],
        client: { request } as unknown as GatewayBrowserClient,
        agentId: "main",
        pageDepths: new Map([[sessionCatalogHostKey("codex", pending.hostId), 1]]),
        isCurrent: () => true,
        canRequestPage: () => true,
      }),
    ).toEqual(catalogs);
    expect(request).not.toHaveBeenCalled();
  },
);

it("does not replace a settled progressive host with its pending final response", () => {
  const current = catalog("codex", 1);
  const pending = { ...current.hosts[0]!, pending: true, sessions: [] };
  const published = apply(current, [{ ...current, hosts: [pending] }])!;
  expect(live.mergeFinal([{ ...current, hosts: [pending] }], published.catalogs)).toEqual([
    current,
  ]);
});

it.each([0, 1])(
  "retains failed hosts without losing another host (expanded pages: %s)",
  (depth) => {
    const current = catalog("codex", 2);
    current.capabilities.startTerminal = true;
    current.hosts.forEach((host) => {
      host.canStartTerminal = true;
    });
    const changed = {
      ...current.hosts[0]!,
      canStartTerminal: false,
      sessions: [],
      error: { code: "offline", message: "Offline" },
    };
    const result = apply(
      { ...current, hosts: [changed] },
      [current],
      new Map([[sessionCatalogHostKey("codex", changed.hostId), depth]]),
    );
    expect(result?.catalogs[0]?.hosts.map((host) => host.canStartTerminal)).toEqual([false, true]);
    expect(result?.catalogs[0]?.hosts[1]).toEqual(current.hosts[1]);
    expect(result?.catalogs[0]?.hosts[0]?.sessions).toEqual(current.hosts[0]?.sessions);
  },
);
it("compares a host event only with the catalog and host it can replace", () => {
  const changed = catalog("changed", 1);
  const unrelated = catalog("unrelated", 100);
  Object.defineProperty(unrelated, "toJSON", {
    value: () => {
      throw new Error("unrelated catalog serialized");
    },
  });

  expect(apply(changed, [changed, unrelated])).toBeNull();
});

it("retains catalog-level pending hosts and failure until settled enumeration withdraws them", async () => {
  const current = catalog("codex", 2);
  current.error = { code: "catalog_stale", message: "Last enumeration failed" };
  current.hosts[0]!.nextCursor = "expanded";
  const incoming = { ...catalog("codex", 0), pending: true };
  const request = vi.fn();
  const refreshed = await refetchExpandedSessionCatalogPages({
    catalogs: live.mergeFinal([incoming], [current]),
    previousCatalogs: [current],
    client: { request } as unknown as GatewayBrowserClient,
    agentId: "main",
    pageDepths: new Map([[sessionCatalogHostKey("codex", current.hosts[0]!.hostId), 1]]),
    isCurrent: () => true,
    canRequestPage: () => true,
  });
  expect(refreshed[0]?.error).toEqual(current.error);
  expect(refreshed[0]?.hosts).toEqual(current.hosts.map((host) => ({ ...host, pending: true })));
  expect(request).not.toHaveBeenCalled();
  const withdrawn = { ...current.hosts[0]!, sessions: [], nextCursor: undefined };
  const partial = await refetchExpandedSessionCatalogPages({
    catalogs: [{ ...incoming, hosts: [withdrawn] }],
    previousCatalogs: [current],
    client: { request } as unknown as GatewayBrowserClient,
    agentId: "main",
    pageDepths: new Map([[sessionCatalogHostKey("codex", withdrawn.hostId), 1]]),
    isCurrent: () => true,
    canRequestPage: () => true,
  });
  expect(partial[0]?.hosts[0]?.sessions).toEqual([]);
  expect(partial[0]?.hosts[0]?.pending).toBeUndefined();
  expect(partial[0]?.hosts[1]).toEqual({ ...current.hosts[1], pending: true });
  expect(request).not.toHaveBeenCalled();
  expect(live.mergeFinal([catalog("codex", 0)], refreshed)).toEqual([catalog("codex", 0)]);
});

it.each([
  { ids: [], truncated: false },
  { ids: ["replacement"], truncated: false },
  { ids: ["frontier"], truncated: true },
])(
  "applies an exhausted progressive host snapshot: $ids (truncated=$truncated)",
  ({ ids, truncated }) => {
    const current = catalog("codex", 1);
    current.hosts[0]!.nextCursor = "expanded-next";
    const fresh = catalog("codex", 1);
    fresh.hosts[0]!.sessions = ids.map((threadId) => ({ ...idleSession, threadId }));
    if (truncated) {
      fresh.hosts[0]!.error = { code: "DISCOVERY_TRUNCATED", message: "Search by exact ID" };
    }
    const update = apply(
      fresh,
      [current],
      new Map([[sessionCatalogHostKey("codex", fresh.hosts[0]!.hostId), 2]]),
    );
    expect(update?.catalogs).toEqual([fresh]);
    const pendingFinal = { ...fresh, hosts: [{ ...fresh.hosts[0]!, pending: true, sessions: [] }] };
    expect(live.mergeFinal([pendingFinal], update!.catalogs)).toEqual([fresh]);
  },
);
