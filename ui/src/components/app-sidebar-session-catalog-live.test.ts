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

it("clears unavailable native readiness without losing another host or expanded rows", () => {
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
    new Map([[sessionCatalogHostKey("codex", changed.hostId), 1]]),
  );
  expect(result?.catalogs[0]?.hosts.map((host) => host.canStartTerminal)).toEqual([false, true]);
  expect(result?.catalogs[0]?.hosts[1]).toEqual(current.hosts[1]);
  expect(result?.catalogs[0]?.hosts[0]?.sessions).toEqual(current.hosts[0]?.sessions);
});
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
