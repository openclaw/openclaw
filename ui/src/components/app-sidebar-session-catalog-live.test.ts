// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  refreshSessionCatalogsLive,
  SessionCatalogLiveState,
} from "./app-sidebar-session-catalog-live.ts";
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
function apply(incoming: SessionCatalog, catalogs: SessionCatalog[], depth = 0) {
  return live.applyHost({
    payload: { progressId, agentId: "main", catalog: incoming },
    agentId: "main",
    catalogs,
    pageDepths: new Map([[sessionCatalogHostKey(incoming.id, incoming.hosts[0]!.hostId), depth]]),
  });
}

it("retains pending rows, cursors, errors and siblings until recovery", () => {
  const current = catalog("codex", 2);
  current.hosts[0]!.error = { code: "NODE_INVOKE_FAILED", message: "Fixture node failed" };
  current.hosts[0]!.nextCursor = "next-page";
  current.error = { code: "catalog_stale", message: "Last enumeration failed" };
  const pending = apply(
    {
      ...current,
      error: undefined,
      pending: true,
      hosts: [{ ...catalog("codex", 1).hosts[0]!, pending: true, sessions: [] }],
    },
    [current],
  );
  expect(pending?.catalogs[0]?.pending).toBe(true);
  expect(pending?.catalogs[0]?.error).toEqual(current.error);
  expect(pending?.catalogs[0]?.hosts[0]).toMatchObject({
    pending: true,
    error: { code: "NODE_INVOKE_FAILED" },
    sessions: current.hosts[0]!.sessions,
    nextCursor: "next-page",
  });
  expect(pending?.catalogs[0]?.hosts[1]).toEqual(current.hosts[1]);
  expect(apply(catalog("codex", 1), pending!.catalogs)?.catalogs).toEqual([catalog("codex", 2)]);
});

it("retains failed host rows and sibling hosts while updating capabilities", () => {
  const current = catalog("codex", 2);
  current.hosts[1]!.canStartTerminal = true;
  const changed = {
    ...current.hosts[0]!,
    canStartTerminal: false,
    sessions: [],
    error: { code: "offline", message: "Offline" },
  };
  const result = apply({ ...current, hosts: [changed] }, [current]);
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
    const update = apply(fresh, [current], 2);
    expect(update?.catalogs).toEqual([fresh]);
    const pendingFinal = { ...fresh, hosts: [{ ...fresh.hosts[0]!, pending: true, sessions: [] }] };
    expect(live.mergeFinal([pendingFinal], update!.catalogs)).toEqual([fresh]);
  },
);

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "discovers capabilities without prefetch and isolates unresolved selection (%s)",
  async (unresolved) => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const shared = {
      ...catalog("openclaw", 1),
      capabilities: { continueSession: false, archive: false, profileRelation: true as const },
    };
    const native = catalog("codex", 1);
    const query = { relationship: "involving" as const, target: { type: "me" as const } };
    const request = vi.fn(async (_method: string, args: Record<string, unknown>) => {
      if (args.metadataOnly) {
        return {
          catalogs: [
            { ...shared, hosts: [] },
            { ...native, hosts: [] },
          ],
        };
      }
      if (args.catalogId === "openclaw") {
        expect(args.profileRelation).toEqual(query);
        if (unresolved) {
          throw new Error("Profile selection has no verified GitHub identity");
        }
        return { catalogs: [shared] };
      }
      expect(args.catalogId).toBe("codex");
      expect(args.profileRelation).toBeUndefined();
      return { catalogs: [native] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const current = new SessionCatalogLiveState();
    let catalogs: SessionCatalog[] = [];
    await refreshSessionCatalogsLive({
      live: current,
      client,
      agentId: "main",
      profileRelation: query,
      generation: 1,
      currentGeneration: () => 1,
      currentClient: () => client,
      catalogs: () => catalogs,
      pageDepths: new Map(),
      connected: () => true,
      withdrawPrevious: () => {},
      applyFinal: (result) => {
        catalogs = result;
      },
      continueRefresh: async () => {},
      applyError: (error) => {
        throw error;
      },
      refresh: async () => {},
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[1]).toEqual({ agentId: "main", metadataOnly: true });
    expect(catalogs.find(({ id }) => id === "codex")).toEqual(native);
    const result = catalogs.find(({ id }) => id === "openclaw");
    if (unresolved) {
      expect(result?.hosts).toEqual([]);
      expect(result?.error?.message).toContain("verified GitHub");
    } else {
      expect(result).toEqual(shared);
    }
    expect(request.mock.calls.slice(1).map(([, args]) => args.pollId)).toEqual([
      current.pollId,
      current.pollId,
    ]);
  },
);
