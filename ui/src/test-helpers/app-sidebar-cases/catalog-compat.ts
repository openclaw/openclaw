import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { catalogPage, createSessions, mountSidebar } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import "../../components/app-sidebar.tsx";
import {
  agentList,
  catalogGateway,
  mountCatalog,
  startCatalog,
  settleCatalog,
} from "./compact.test-support.ts";

function offlineHost(
  id: string,
  label: string,
  error = { code: "NODE_OFFLINE", message: "Paired node is offline" },
): SessionCatalogHost {
  return { hostId: `node:${id}`, label, kind: "node", connected: false, sessions: [], error };
}

describe("AppSidebar session catalog pagination", () => {
  beforeEach(() => vi.useFakeTimers());
  it("refreshes catalog creation capability for the expanded agent", async () => {
    const request = vi.fn().mockResolvedValue(catalogPage([]));
    const { sidebar, context } = await mountCatalog(
      { request } as unknown as GatewayBrowserClient,
      {
        agents: agentList([{ id: "main" }, { id: "research" }]),
      },
    );

    expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", {
      agentId: "main",
      limitPerHost: 40,
      progressId: expect.any(String),
      allowPartialResults: true,
    });

    const selection = context.agentSelection.state as {
      selectedId: string | null;
      scopeId: string | null;
    };
    selection.selectedId = "research";
    selection.scopeId = "research";
    sidebar.invalidate();
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(50);

    expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
      agentId: "research",
      limitPerHost: 40,
      progressId: expect.any(String),
      allowPartialResults: true,
    });
  });

  it.each(["empty", "catalog error", "host error", "native start"] as const)(
    "shows failures for empty catalogs while hiding healthy empty catalogs (%s)",
    async (state) => {
      const codex = catalogPage([]);
      const claude = catalogPage([], undefined, "claude");
      for (const catalog of [...codex.catalogs, ...claude.catalogs]) {
        if (state === "catalog error") {
          catalog.error = { code: "UNAVAILABLE", message: "Catalog unavailable" };
        } else if (state === "host error") {
          catalog.hosts[0]!.error = { code: "NODE_INVOKE_FAILED", message: "Node unavailable" };
        } else if (state === "native start") {
          catalog.capabilities.startTerminal = true;
        }
      }
      const request = vi.fn().mockResolvedValue({
        catalogs: [...codex.catalogs, ...claude.catalogs],
      });
      const { sidebar } = await mountCatalog({
        request,
      } as unknown as GatewayBrowserClient);
      const dom = domProbe(sidebar);
      await sidebar.updateComplete;

      for (const id of ["codex", "claude"]) {
        const section = dom.query(`[data-session-section="catalog:${id}"]`);
        if (state === "catalog error" || state === "host error") {
          expect(section).not.toBeNull();
          expect(section?.querySelector(`[data-session-catalog-error="${id}"]`)).not.toBeNull();
          expect(section?.querySelector(".sidebar-recent-sessions__list")?.childElementCount).toBe(
            0,
          );
          expect(
            section?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
          ).toContain(
            state === "catalog error"
              ? "[UNAVAILABLE] Catalog unavailable"
              : "[NODE_INVOKE_FAILED] Node unavailable",
          );
        } else {
          expect(section).toBeNull();
        }
      }
    },
  );

  it("keeps populated catalogs visible with actionable errors and hides empty offline hosts", async () => {
    const request = vi.fn().mockResolvedValue({
      catalogs: [
        {
          id: "codex",
          label: "Codex",
          capabilities: { continueSession: true, archive: true },
          hosts: catalogPage([{ threadId: "local-session", name: "Local session" }]).catalogs[0]!
            .hosts,
          error: { code: "unavailable", message: "Codex provider unavailable" },
        },
        {
          id: "claude",
          label: "Claude",
          capabilities: {
            continueSession: true,
            archive: true,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
          hosts: [
            ...catalogPage([{ threadId: "remote-session", name: "Remote session" }]).catalogs[0]!
              .hosts,
            ...["a", "b"].map((id) => offlineHost(`offline-${id}`, `Offline ${id.toUpperCase()}`)),
            ...["registry", "registry-duplicate"].map((id) =>
              offlineHost(id, "Paired nodes", {
                code: "NODE_LIST_FAILED",
                message: "Paired nodes could not be listed",
              }),
            ),
          ],
        },
      ],
    });
    const { sidebar } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);
    const dom = domProbe(sidebar);
    await sidebar.updateComplete;

    const codexSection = dom.query('[data-session-section="catalog:codex"]');
    const claudeSection = dom.query('[data-session-section="catalog:claude"]');
    expect(codexSection).not.toBeNull();
    expect(claudeSection).not.toBeNull();
    expect(codexSection?.querySelector(".sidebar-session-group-count")?.textContent).not.toBe("0");
    expect(claudeSection?.querySelector(".sidebar-session-group-count")?.textContent).not.toBe("0");
    expect(
      codexSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
    ).toContain("[unavailable] Codex provider unavailable");
    expect(
      claudeSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
    ).toContain("[NODE_LIST_FAILED] Paired nodes could not be listed");
    const claudeTitle =
      claudeSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("title") ?? "";
    expect(claudeTitle).not.toContain("NODE_OFFLINE");
    expect(claudeTitle.match(/NODE_LIST_FAILED/g)).toHaveLength(1);
    expect(claudeSection?.querySelectorAll("[data-session-catalog-host]")).toHaveLength(1);
    expect(codexSection?.textContent).toContain("Local session");
    expect(claudeSection?.textContent).toContain("Remote session");
    expect(
      codexSection?.querySelector(".sidebar-session-group-toggle")?.getAttribute("title"),
    ).toContain("Settings > Appearance > Session sources");
    expect(codexSection?.querySelector('[data-session-catalog-error="codex"]')).not.toBeNull();
    expect(claudeSection?.querySelector('[data-session-catalog-error="claude"]')).not.toBeNull();
  });

  it.each(["empty", "other owners"] as const)(
    "discovers matching sessions after %s pages",
    async (firstPageKind) => {
      const ada = { id: "profile-ada", label: "Ada", type: "human" } as const;
      const bob = { id: "profile-bob", label: "Bob", type: "human" } as const;
      const firstPage = catalogPage(
        firstPageKind === "empty"
          ? []
          : Array.from({ length: 40 }, (_, index) => ({
              threadId: `other-${index}`,
              name: `Other owner ${index}`,
            })),
        "page-2",
      );
      for (const session of firstPage.catalogs[0]!.hosts[0]!.sessions) {
        session.createdActor = bob;
      }
      const laterPage = catalogPage([{ threadId: "thread-1", name: "Later session" }]);
      laterPage.catalogs[0]!.hosts[0]!.sessions[0]!.createdActor = ada;
      const pending = deferred<typeof laterPage>();
      const request = vi.fn((_method, params: { cursors?: Record<string, string> }) =>
        params.cursors?.["gateway:local"] === "page-2"
          ? pending.promise
          : Promise.resolve(firstPage),
      );
      const gateway = catalogGateway({ request } as unknown as GatewayBrowserClient);
      const sessions = createSessions("main", ["agent:main:main"]);
      sessions.state.result!.owners = [ada, bob];
      const { sidebar } = await mountSidebar(gateway.gateway, sessions);
      const dom = domProbe(sidebar);
      sidebar.setSessionOwnerFilter(ada.id);
      await sidebar.updateComplete;
      await startCatalog(sidebar);
      await sidebar.updateComplete;

      expect(dom.query('[data-session-section="catalog:codex"]')).toBeNull();
      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
      pending.resolve(laterPage);
      await settleCatalog(sidebar);
      expect(sidebar.textContent).toContain("Later session");
      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Later session");
    },
  );

  it("shows a rejected load-more request and clears it after a successful retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2"))
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "Second page unavailable" }),
      )
      .mockResolvedValueOnce(catalogPage([{ threadId: "thread-2", name: "Older" }]));
    const { sidebar } = await mountCatalog({
      request,
    } as unknown as GatewayBrowserClient);
    const dom = domProbe(sidebar);
    await sidebar.updateComplete;

    const section = () => dom.query('[data-session-section="catalog:codex"]');
    const loadMore = () => dom.query<HTMLButtonElement>('[data-session-catalog-load-more="codex"]');
    loadMore()?.click();
    await settleCatalog(sidebar);

    expect(section()?.querySelector('[data-session-catalog-error="codex"]')).not.toBeNull();
    expect(
      section()?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label"),
    ).toContain("Second page unavailable");
    expect(sidebar.sessionData.sessionCatalogs[0]?.error?.code).toBe("UNAVAILABLE");
    expect(sidebar.sessionData.sessionCatalogs[0]?.hosts[0]?.nextCursor).toBe("page-2");
    expect(loadMore()?.disabled).toBe(false);

    loadMore()?.click();
    await settleCatalog(sidebar);

    expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.list", {
      agentId: "main",
      catalogId: "codex",
      hostIds: ["gateway:local"],
      cursors: { "gateway:local": "page-2" },
    });
    expect(section()?.querySelector('[data-session-catalog-error="codex"]')).toBeNull();
    expect(sidebar.textContent).toContain("Older");
    expect(loadMore()).toBeNull();
  });
});
