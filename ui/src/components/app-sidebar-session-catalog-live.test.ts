// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
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
