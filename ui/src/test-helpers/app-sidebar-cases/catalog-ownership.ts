import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  catalogPage,
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar session catalog ownership", () => {
  it.each([false, true])(
    "omits the lone Other header when owner filtering hides every catalog row (adopted: %s)",
    async (adopted) => {
      const ownKey = "agent:main:own-task";
      const catalogKey = "agent:main:catalog-task";
      const harness = createSessionsHarness("main", [ownKey, ...(adopted ? [catalogKey] : [])]);
      const result = harness.sessions.state.result!;
      const ada = { type: "human", id: "profile-ada", label: "Ada" } as const;
      const bob = { type: "human", id: "profile-bob", label: "Bob" } as const;
      result.owners = [ada, bob];
      for (const row of result.sessions) {
        row.owner = { actor: row.key === ownKey ? ada : bob };
      }
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        harness.sessions,
      );
      const page = catalogPage([
        {
          threadId: "other-thread",
          name: "Other owner's session",
          sessionKey: adopted ? catalogKey : undefined,
        },
      ]);
      // Adoption replaces creator provenance with the loaded session's owner.
      page.catalogs[0]!.hosts[0]!.sessions[0]!.createdActor = adopted ? ada : bob;
      page.catalogs[0]!.hosts[0]!.nextCursor = "more-owner-filtered-sessions";
      page.catalogs[0]!.error = { code: "UNAVAILABLE", message: "Another host is unavailable" };
      sidebar.sessionData.sessionCatalogs = page.catalogs;
      sidebar.sessionData.requestSessionDataUpdate();
      await sidebar.updateComplete;
      const header = () =>
        sidebar.querySelector('[data-session-section="ungrouped"] .sidebar-recent-sessions__head');
      expect(header()).not.toBeNull();
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull();

      sidebar.setSessionOwnerFilter(ada.id);
      await sidebar.updateComplete;
      await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
      await sidebar.updateComplete;
      expect(sidebar.querySelector(`[data-session-key="${ownKey}"]`)).not.toBeNull();
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
      expect(header()).toBeNull();

      sidebar.setSessionOwnerFilter(null);
      await sidebar.updateComplete;
      await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull();
      expect(header()).not.toBeNull();
    },
  );

  it.each([
    { owner: "the selected agent", assistantAgentId: null },
    { owner: "the advertised catalog capability", assistantAgentId: "main" },
  ])(
    "retires catalog rows and creation after reconnect loses $owner",
    async ({ assistantAgentId }) => {
      vi.useFakeTimers();
      let provider: HTMLElement | undefined;
      try {
        const firstPage = catalogPage(
          [{ threadId: "thread-1", name: "Retired session" }],
          "page-2",
        );
        const catalog = firstPage.catalogs[0];
        if (!catalog) {
          throw new Error("expected a session catalog");
        }
        catalog.capabilities.startTerminal = true;
        const expandedPage = catalogPage([{ threadId: "thread-2", name: "Retired page" }]);
        const expandedCatalog = expandedPage.catalogs[0];
        if (!expandedCatalog) {
          throw new Error("expected an expanded session catalog");
        }
        expandedCatalog.capabilities.startTerminal = catalog.capabilities.startTerminal;
        const request = vi
          .fn()
          .mockResolvedValueOnce(firstPage)
          .mockResolvedValueOnce(expandedPage);
        const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
        const catalogHello = {
          type: "hello-ok",
          protocol: 1,
          auth: { role: "operator", scopes: ["operator.admin"] },
          features: { methods: ["sessions.catalog.list"] },
        } satisfies NonNullable<ApplicationGatewaySnapshot["hello"]>;
        gateway.publish({ hello: catalogHello });
        const mounted = await mountSidebar(
          gateway.gateway,
          createSessions("main", ["agent:main:main"]),
        );
        const { sidebar } = mounted;
        provider = mounted.provider;
        sidebar.connected = true;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);

        await sidebar.sessionData.loadMoreSessionCatalog("codex");
        await sidebar.updateComplete;
        expect(sidebar.textContent).toContain("Retired session");
        expect(sidebar.textContent).toContain("Retired page");
        expect(sidebar.querySelector(".sidebar-session-catalog-new")).not.toBeNull();
        expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);
        expect(sidebar.sessionData.sessionCatalogRevisions.size).toBe(1);

        gateway.publish({ phase: "reconnecting", hello: null });
        await sidebar.updateComplete;
        expect(sidebar.textContent).toContain("Retired page");
        expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

        gateway.publish({
          phase: "connected",
          assistantAgentId,
          hello: { ...catalogHello, features: { ...catalogHello.features, methods: [] } },
        });
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;

        expect(sidebar.sessionData.sessionCatalogAgentId).toBeNull();
        expect(sidebar.sessionData.sessionCatalogs).toEqual([]);
        expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);
        expect(sidebar.sessionData.sessionCatalogRevisions.size).toBe(0);
        expect(sidebar.textContent).not.toContain("Retired session");
        expect(sidebar.textContent).not.toContain("Retired page");
        expect(sidebar.querySelector(".sidebar-session-catalog-new")).toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        provider?.remove();
        vi.useRealTimers();
      }
    },
  );
});
