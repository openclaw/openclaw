import { expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { catalogPage, mountSessionCatalogSidebar } from "../app-sidebar.ts";

export function registerCatalogPageHostTests() {
  it("pages only cursor hosts and preserves exhausted hosts through a catalog change", async () => {
    vi.useFakeTimers();
    try {
      const exhaustedHost: SessionCatalogHost = {
        ...catalogPage([{ threadId: "exhausted", name: "Retained remote session" }]).catalogs[0]!
          .hosts[0]!,
        hostId: "node:exhausted",
        label: "Exhausted host",
        kind: "node",
        connected: false,
        error: { code: "NODE_OFFLINE", message: "Remote host unavailable" },
      };
      const firstPage = catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2");
      const refreshedFirstPage = catalogPage(
        [{ threadId: "thread-1", name: "Newest refreshed" }],
        "page-2",
      );
      for (const page of [firstPage, refreshedFirstPage]) {
        page.catalogs[0]!.hosts.push(exhaustedHost);
      }
      const request = vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-2", name: "Stale title" }], "page-3"),
        )
        .mockResolvedValueOnce(refreshedFirstPage)
        .mockResolvedValueOnce(
          catalogPage([{ threadId: "thread-2", name: "Current title" }], "page-3"),
        )
        .mockResolvedValueOnce(catalogPage([{ threadId: "thread-3", name: "Oldest" }]));
      const { gateway, sidebar } = await mountSessionCatalogSidebar({
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
      expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
        progressId: expect.any(String),
        allowPartialResults: true,
      });
      expect(catalogRows()).toHaveLength(2);
      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;

      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
      expect(catalogRows()).toHaveLength(3);
      expect(sidebar.textContent).toContain("Stale title");
      expect(sidebar.textContent).toContain("Retained remote session");
      expect(retainedHost()).toEqual(exhaustedHost);

      gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
      await vi.advanceTimersByTimeAsync(5_000);
      await sidebar.updateComplete;
      expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.list", {
        agentId: "main",
        limitPerHost: 40,
        progressId: expect.any(String),
        allowPartialResults: true,
      });
      expect(request).toHaveBeenNthCalledWith(4, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
      expect(catalogRows()).toHaveLength(3);
      expect(sidebar.textContent).toContain("Newest refreshed");
      expect(sidebar.textContent).toContain("Current title");
      expect(sidebar.textContent).not.toContain("Stale title");
      expect(retainedHost()).toEqual(exhaustedHost);

      loadMore()?.click();
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(request).toHaveBeenNthCalledWith(5, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-3" },
      });
      expect(catalogRows()).toHaveLength(4);
      expect(sidebar.textContent).toContain("Oldest");
      expect(retainedHost()).toEqual(exhaustedHost);
      expect(loadMore()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
}
