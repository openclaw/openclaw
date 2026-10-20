import { expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { catalogPage, mountSessionCatalogSidebar } from "../app-sidebar.ts";
import { settleCatalog } from "./compact.test-support.ts";

const page = (threadId: string, name: string, cursor?: string) =>
  catalogPage([{ threadId, name }], cursor);
const listRequest = {
  agentId: "main",
  limitPerHost: 40,
  progressId: expect.any(String),
  allowPartialResults: true,
};
const cursorRequest = (cursor: string) => ({
  agentId: "main",
  catalogId: "codex",
  hostIds: ["gateway:local"],
  cursors: { "gateway:local": cursor },
});

export function registerCatalogPageHostTests() {
  it("pages only cursor hosts and preserves exhausted hosts through a catalog refresh", async () => {
    vi.useFakeTimers();
    try {
      const exhaustedHost: SessionCatalogHost = {
        ...page("exhausted", "Retained remote session").catalogs[0]!.hosts[0]!,
        hostId: "node:exhausted",
        label: "Exhausted host",
        kind: "node",
        connected: false,
        error: { code: "NODE_OFFLINE", message: "Remote host unavailable" },
      };
      const firstPage = page("thread-1", "Newest", "page-2");
      const refreshedFirstPage = page("thread-1", "Newest refreshed", "page-2");
      for (const response of [firstPage, refreshedFirstPage]) {
        response.catalogs[0]!.hosts.push(exhaustedHost);
      }
      const request = vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(page("thread-2", "Stale title", "page-3"))
        .mockResolvedValueOnce(refreshedFirstPage)
        .mockResolvedValueOnce(page("thread-2", "Current title", "page-3"))
        .mockResolvedValueOnce(page("thread-3", "Oldest"));
      const { sidebar } = await mountSessionCatalogSidebar({
        request,
      } as unknown as GatewayBrowserClient);

      const catalogRows = () =>
        sidebar.querySelectorAll('[data-session-section="catalog:codex"] [data-session-key]');
      const loadMore = () =>
        sidebar.querySelector<HTMLButtonElement>('[data-session-catalog-load-more="codex"]');
      const retainedHost = () =>
        sidebar.sessionData.sessionCatalogs[0]?.hosts.find(
          (host) => host.hostId === exhaustedHost.hostId,
        );
      expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", listRequest);
      expect(catalogRows()).toHaveLength(2);
      loadMore()?.click();
      await settleCatalog(sidebar);

      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", cursorRequest("page-2"));
      expect(catalogRows()).toHaveLength(3);
      expect(sidebar.textContent).toContain("Stale title");
      expect(sidebar.textContent).toContain("Retained remote session");
      expect(retainedHost()).toEqual(exhaustedHost);

      document.dispatchEvent(new Event("visibilitychange"));
      await settleCatalog(sidebar, 5_000);
      expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.list", listRequest);
      expect(request).toHaveBeenNthCalledWith(4, "sessions.catalog.list", cursorRequest("page-2"));
      expect(catalogRows()).toHaveLength(3);
      expect(sidebar.textContent).toContain("Newest refreshed");
      expect(sidebar.textContent).toContain("Current title");
      expect(sidebar.textContent).not.toContain("Stale title");
      expect(retainedHost()).toEqual(exhaustedHost);

      loadMore()?.click();
      await settleCatalog(sidebar);
      expect(request).toHaveBeenNthCalledWith(5, "sessions.catalog.list", cursorRequest("page-3"));
      expect(catalogRows()).toHaveLength(4);
      expect(sidebar.textContent).toContain("Oldest");
      expect(retainedHost()).toEqual(exhaustedHost);
      expect(loadMore()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
}
