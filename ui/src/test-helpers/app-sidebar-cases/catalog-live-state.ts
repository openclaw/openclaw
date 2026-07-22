import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshSessionCatalogsLive,
  SESSION_CATALOG_CHANGED_REFRESH_MS,
  SessionCatalogLiveState,
} from "../../components/app-sidebar-session-catalog-live.ts";

afterEach(() => {
  vi.useRealTimers();
});

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

  it("keeps an existing scheduled refresh instead of polling immediately", () => {
    vi.useFakeTimers();
    const live = new SessionCatalogLiveState();
    const refresh = vi.fn();

    live.schedule(SESSION_CATALOG_CHANGED_REFRESH_MS, true, refresh);
    live.requestRefresh({ visible: true, connected: true, generation: 1, refresh });

    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SESSION_CATALOG_CHANGED_REFRESH_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces pending in-flight refreshes onto the changed refresh interval", async () => {
    vi.useFakeTimers();
    const live = new SessionCatalogLiveState();
    const refresh = vi.fn();
    let resolveRequest: (value: { catalogs: [] }) => void = () => {};
    const client = {
      request: vi.fn(
        () =>
          new Promise<{ catalogs: [] }>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    };

    const run = refreshSessionCatalogsLive({
      live,
      client: client as never,
      agentId: "main",
      generation: 1,
      revision: 1,
      currentGeneration: () => 1,
      currentRevision: () => 1,
      currentClient: () => client as never,
      catalogs: () => [],
      pageDepths: new Map(),
      connected: () => true,
      applyFinal: vi.fn(),
      refresh,
    });

    live.requestRefresh({ visible: true, connected: true, generation: 1, refresh });
    resolveRequest({ catalogs: [] });
    await run;

    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SESSION_CATALOG_CHANGED_REFRESH_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
