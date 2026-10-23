import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogErrorPage,
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { registerCatalogPageHostTests } from "./catalog-page-hosts.ts";
import "../../components/app-sidebar.tsx";

function page(threadId: string, name: string, cursor?: string, catalogId?: string) {
  return catalogPage([{ threadId, name }], cursor, catalogId);
}

const catalogHello = () =>
  ({
    auth: { role: "operator", scopes: ["operator.read"] },
    features: { methods: ["sessions.catalog.list"] },
  }) as ApplicationGatewaySnapshot["hello"];

async function advance(sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"], ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await sidebar.updateComplete;
}

function moreButton(sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"], id = "codex") {
  return sidebar.querySelector<HTMLButtonElement>(`[data-session-catalog-load-more="${id}"]`);
}

async function mountCatalog(
  request: ReturnType<typeof vi.fn>,
  agents: typeof TWO_AGENTS | null = null,
) {
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const hello = catalogHello();
  gateway.publish({ hello });
  const mounted = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
    "panel",
    agents,
  );
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  await advance(mounted.sidebar);
  return { ...mounted, gateway, hello };
}

describe("AppSidebar session catalog pagination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it("keeps an in-flight catalog refresh across a stable same-client Gateway notification", async () => {
    // Shared UI workers retain real custom elements despite later module mocks.
    await vi.importActual("../../components/sidebar-attention.tsx");
    const pendingPage = deferred<SessionsCatalogListResult>();
    const request = vi.fn().mockReturnValue(pendingPage.promise);
    const { sidebar, gateway } = await mountCatalog(request);

    expect(request).toHaveBeenCalledTimes(1);
    const generation = sidebar.sessionData.sessionScopeGeneration;

    gateway.publish({ offlineStable: true });
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(sidebar.sessionData.sessionScopeGeneration).toBe(generation);
    expect(request).toHaveBeenCalledTimes(1);

    pendingPage.resolve(page("thread-1", "Current session"));
    await advance(sidebar);

    expect(sidebar.textContent).toContain("Current session");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases a pending catalog page across a same-client Gateway reconnect", async () => {
    const pendingStalePage = deferred<SessionsCatalogListResult>();
    const pendingFreshPage = deferred<SessionsCatalogListResult>();
    const firstPage = page("thread-1", "Newest", "page-2");
    const expandedPage = page("thread-2", "Expanded", "page-3");
    let requestedThirdPages = 0;
    const request = vi.fn((_method: string, params: { cursors?: Record<string, string> }) => {
      const cursor = params.cursors?.["gateway:local"];
      if (cursor === "page-2") {
        return Promise.resolve(expandedPage);
      }
      if (cursor === "page-3") {
        requestedThirdPages += 1;
        return requestedThirdPages === 1 ? pendingStalePage.promise : pendingFreshPage.promise;
      }
      return Promise.resolve(firstPage);
    });
    const { sidebar, gateway, hello } = await mountCatalog(request);

    await sidebar.sessionData.loadMoreSessionCatalog("codex");
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Expanded");
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

    const staleLoad = sidebar.sessionData.loadMoreSessionCatalog("codex");
    await sidebar.updateComplete;
    expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(true);

    gateway.publish({ phase: "reconnecting", hello: null });
    sidebar.sessionData.synchronize();
    expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(false);
    await sidebar.updateComplete;
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

    gateway.publish({ phase: "connected", hello });
    await sidebar.updateComplete;
    await advance(sidebar);

    expect(sidebar.textContent).toContain("Expanded");
    const loadMore = moreButton(sidebar);
    expect(loadMore?.disabled).toBe(false);
    loadMore?.click();
    await sidebar.updateComplete;
    expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(true);

    pendingStalePage.resolve(page("stale", "Stale page"));
    await staleLoad;
    await sidebar.updateComplete;
    expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(true);
    expect(sidebar.textContent).not.toContain("Stale page");

    pendingFreshPage.resolve(page("thread-3", "Fresh page"));
    await advance(sidebar);
    expect(sidebar.sessionData.loadingMoreSessionCatalogIds.has("codex")).toBe(false);
    expect(sidebar.textContent).toContain("Fresh page");
  });

  it("retires visible catalog rows and expanded cursors when the agent changes", async () => {
    const pendingResearch = deferred<SessionsCatalogListResult>();
    const mainFirstPage = page("main-newest", "Main newest", "main-page-2");
    const mainSecondPage = page("main-older", "Main older");
    const researchFirstPage = page("research-newest", "Research newest", "research-page-2");
    const request = vi
      .fn()
      .mockResolvedValueOnce(mainFirstPage)
      .mockResolvedValueOnce(mainSecondPage)
      .mockReturnValueOnce(pendingResearch.promise)
      .mockResolvedValue(page("research-older", "Research older"));
    const { sidebar, context } = await mountCatalog(request, TWO_AGENTS);

    moreButton(sidebar)?.click();
    await advance(sidebar);

    expect(sidebar.textContent).toContain("Main newest");
    expect(sidebar.textContent).toContain("Main older");
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

    context.agentSelection.state.selectedId = "research";
    context.agentSelection.state.scopeId = "research";
    sidebar.invalidate();
    await sidebar.updateComplete;
    await advance(sidebar, 200);

    expect(sidebar.textContent).not.toContain("Main newest");
    expect(sidebar.textContent).not.toContain("Main older");
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);

    pendingResearch.resolve(researchFirstPage);
    await advance(sidebar);

    expect(sidebar.textContent).toContain("Research newest");
    expect(sidebar.textContent).not.toContain("Research older");
    expect(request).not.toHaveBeenCalledWith(
      "sessions.catalog.list",
      expect.objectContaining({
        agentId: "research",
        catalogId: "codex",
        cursors: { "gateway:local": "research-page-2" },
      }),
    );
  });

  it.each(["catalog", "host"] as const)(
    "preserves the current page while exposing a structured %s load-more error",
    async (errorOwner) => {
      const structuredError = catalogErrorPage("Host page failed");
      if (errorOwner === "catalog") {
        const catalog = structuredError.catalogs[0]!;
        catalog.hosts = [];
        catalog.error = { code: "catalog_error", message: "Catalog page failed" };
      }
      const request = vi
        .fn()
        .mockResolvedValueOnce(page("thread-1", "Newest", "page-2"))
        .mockResolvedValueOnce(structuredError)
        .mockResolvedValueOnce(page("thread-2", "Older"));
      const { sidebar } = await mountCatalog(request);

      const loadMore = () => moreButton(sidebar);
      loadMore()?.click();
      await advance(sidebar);

      const section = sidebar.querySelector('[data-session-section="catalog:codex"]');
      expect(section?.querySelector('[data-session-catalog-error="codex"]')).not.toBeNull();
      expect(
        section?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
      ).toContain(errorOwner === "catalog" ? "Catalog page failed" : "Host page failed");
      expect(sidebar.textContent).toContain("Newest");
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-2");

      loadMore()?.click();
      await advance(sidebar);
      expect(sidebar.querySelector('[data-session-catalog-error="codex"]')).toBeNull();
      expect(sidebar.textContent).toContain("Older");
    },
  );

  registerCatalogPageHostTests();

  it("discards a load-more response after a catalog refresh replaces its cursor", async () => {
    const stalePage = deferred<SessionsCatalogListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page("thread-1", "Initial", "page-2"))
      .mockReturnValueOnce(stalePage.promise)
      .mockResolvedValueOnce(page("thread-1", "Updated", "replacement-page"))
      .mockResolvedValueOnce(page("thread-3", "Replacement"));
    const { sidebar } = await mountCatalog(request);

    const loadMore = () => moreButton(sidebar);
    loadMore()?.click();
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(sidebar, 5_000);
    expect(sidebar.textContent).toContain("Updated");

    stalePage.resolve(page("thread-2", "Stale page", "page-3"));
    await advance(sidebar);
    expect(sidebar.textContent).not.toContain("Stale page");

    loadMore()?.click();
    await advance(sidebar);
    expect(request).toHaveBeenNthCalledWith(4, "sessions.catalog.list", {
      agentId: "main",
      catalogId: "codex",
      hostIds: ["gateway:local"],
      cursors: { "gateway:local": "replacement-page" },
    });
    expect(sidebar.textContent).toContain("Replacement");
  });

  it.each(["first page", "expanded page"])(
    "keeps expanded rows while exposing a structured error from the %s refresh",
    async (errorPage) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(page("thread-1", "Newest", "page-2"))
        .mockResolvedValueOnce(page("thread-2", "Older"))
        .mockResolvedValueOnce(
          errorPage === "first page"
            ? catalogErrorPage("Base refresh failed")
            : page("thread-1", "Newest", "page-2"),
        );
      if (errorPage === "expanded page") {
        request.mockResolvedValueOnce(catalogErrorPage("Page refresh failed"));
      }
      const { sidebar } = await mountCatalog(request);

      moreButton(sidebar)?.click();
      await advance(sidebar);
      expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.sessions).toHaveLength(2);

      document.dispatchEvent(new Event("visibilitychange"));
      await advance(sidebar, 5_000);
      const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
      expect(host?.sessions.map((session) => session.threadId)).toEqual(["thread-1", "thread-2"]);
      expect(host?.connected).toBe(false);
      expect(host?.label).toBe("Unavailable host");
      expect(host?.error?.message).toBe(
        errorPage === "first page" ? "Base refresh failed" : "Page refresh failed",
      );
      expect(host?.nextCursor).toBeUndefined();
      expect(sidebar.querySelector('[data-session-catalog-load-more="codex"]')).toBeNull();
    },
  );

  it("keeps a reappearing host's first page when replaying its saved depth fails", async () => {
    const emptyCatalog = catalogPage([]);
    emptyCatalog.catalogs[0]!.hosts = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce(page("thread-1", "Initial", "page-2"))
      .mockResolvedValueOnce(page("thread-2", "Older"))
      .mockResolvedValueOnce(emptyCatalog)
      .mockResolvedValueOnce(page("thread-3", "Reappeared", "page-2"))
      .mockResolvedValue(catalogErrorPage("Replay failed"));
    const { sidebar } = await mountCatalog(request);
    moreButton(sidebar)?.click();
    await advance(sidebar);

    document.dispatchEvent(new Event("visibilitychange"));
    await advance(sidebar, 5_000);
    expect(sidebar.sessionData.sessionCatalogs[0]?.hosts).toEqual([]);

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sidebar.sessionData.sessionCatalogs[0]?.hosts).toEqual([]);
    await advance(sidebar, 1);
    const host = sidebar.sessionData.sessionCatalogs[0]?.hosts[0];
    expect(host?.sessions.map((session) => session.threadId)).toEqual(["thread-3"]);
    expect(host?.nextCursor).toBe("page-2");
    expect(host?.connected).toBe(false);
    expect(host?.error?.message).toBe("Replay failed");
  });

  it("applies concurrent load-more responses for different catalogs", async () => {
    const codexPage = deferred<SessionsCatalogListResult>();
    const claudePage = deferred<SessionsCatalogListResult>();
    const initialCodex = page("codex-1", "Codex newest", "codex-page-2");
    const initialClaude = page("claude-1", "Claude newest", "claude-page-2", "claude");
    const request = vi
      .fn()
      .mockResolvedValueOnce({ catalogs: [...initialCodex.catalogs, ...initialClaude.catalogs] })
      .mockReturnValueOnce(codexPage.promise)
      .mockReturnValueOnce(claudePage.promise);
    const { sidebar } = await mountCatalog(request);

    moreButton(sidebar)?.click();
    moreButton(sidebar, "claude")?.click();
    codexPage.resolve(page("codex-2", "Codex older"));
    await advance(sidebar);
    claudePage.resolve(page("claude-2", "Claude older", undefined, "claude"));
    await advance(sidebar);

    expect(
      sidebar.sessionData.sessionCatalogs
        .find((catalog) => catalog.id === "codex")
        ?.hosts[0]?.sessions.map((session) => session.threadId),
    ).toEqual(["codex-1", "codex-2"]);
    expect(
      sidebar.sessionData.sessionCatalogs
        .find((catalog) => catalog.id === "claude")
        ?.hosts[0]?.sessions.map((session) => session.threadId),
    ).toEqual(["claude-1", "claude-2"]);
  });
});
