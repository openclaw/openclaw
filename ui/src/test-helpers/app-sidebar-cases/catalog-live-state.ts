import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  refreshSessionCatalogsLive,
  SessionCatalogLiveState,
} from "../../components/app-sidebar-session-catalog-live.ts";
import { catalogPage } from "../app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
  it("keeps the current refetch guard when an older request finishes", () => {
    const live = new SessionCatalogLiveState();
    const older = live.beginRefetch(true);
    const current = live.beginRefetch(true);

    live.endRefetch(older);
    expect(live.refetching).toBe(true);
    live.endRefetch(current);
    expect(live.refetching).toBe(false);
  });

  it("invalidates request ownership when live state is cleared", () => {
    const live = new SessionCatalogLiveState();
    const first = live.beginRequest(1);
    live.clear();
    const second = live.beginRequest(1);

    expect(live.ownsRequest(first.requestOwner)).toBe(false);
    expect(live.ownsRequest(second.requestOwner)).toBe(true);
  });

  it("keeps the safety cadence when only session recency timestamps change", async () => {
    vi.useFakeTimers();
    try {
      const pageAt = (timestamp: number): SessionsCatalogListResult => {
        const page = catalogPage([{ threadId: "thread-active", name: "Active session" }]);
        const catalog = page.catalogs[0];
        const host = catalog?.hosts[0];
        const session = host?.sessions[0];
        if (!catalog || !host || !session) {
          throw new Error("recency catalog fixture is incomplete");
        }
        host.sessions = [{ ...session, updatedAt: timestamp, recencyAt: timestamp }];
        return page;
      };
      let catalogs = pageAt(1).catalogs;
      const client = {
        request: vi.fn().mockResolvedValue(pageAt(2)),
      } as unknown as GatewayBrowserClient;
      const refresh = vi.fn().mockResolvedValue(undefined);

      await refreshSessionCatalogsLive({
        live: new SessionCatalogLiveState(),
        client,
        agentId: "main",
        generation: 1,
        revision: 1,
        currentGeneration: () => 1,
        currentRevision: () => 1,
        currentClient: () => client,
        catalogs: () => catalogs,
        pageDepths: new Map(),
        connected: () => true,
        catalogChangedEvents: true,
        applyFinal: (next) => {
          catalogs = next;
        },
        continueRefresh: async () => {},
        applyError: (error) => {
          throw error;
        },
        refresh,
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
