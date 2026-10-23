import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getAppSidebarOwner } from "../../components/app-sidebar.tsx";
import { catalogPage, createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { gatewayHelloForMethods } from "../gateway-methods.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import { mountCatalog, settleCatalog } from "./compact.test-support.ts";
import { settleRoster } from "./roster.test-support.ts";

const ada = { type: "human", id: "profile-ada", label: "Ada" } as const;
const bob = { type: "human", id: "profile-bob", label: "Bob" } as const;
const catalogSelector = '[data-session-section="catalog:codex"]';

describe("AppSidebar session catalog ownership", () => {
  it("ignores excluded catalog activity while admitting visible rows, errors, and pagination", async () => {
    const sessions = createSessionsHarness("main", ["agent:main:main"]);
    sessions.sessions.state.result!.owners = [ada, bob];
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessions.sessions,
    );
    const dom = domProbe(sidebar);
    const page = catalogPage([{ threadId: "own-thread", name: "Own session" }]);
    const catalog = page.catalogs[0]!;
    catalog.hosts[0]!.sessions[0]!.createdActor = ada;
    const excluded = catalogPage([{ threadId: "other-thread", name: "Excluded session" }])
      .catalogs[0]!.hosts[0]!;
    excluded.hostId = "gateway:other";
    excluded.sessions[0]!.createdActor = bob;
    catalog.hosts.push(excluded);
    const publish = async () => {
      sidebar.sessionData.sessionCatalogs = structuredClone(page.catalogs);
      sidebar.sessionData.requestSessionDataUpdate();
      await settleRoster(sidebar);
    };
    await publish();
    sidebar.setSessionOwnerFilter(ada.id);
    await settleRoster(sidebar);
    expect(sidebar.textContent).toContain("Own session");
    expect(sidebar.textContent).not.toContain("Excluded session");
    const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");

    excluded.sessions[0]!.name = "Excluded latest title";
    excluded.sessions[0]!.updatedAt = Date.now();
    await publish();
    expect(prepare).not.toHaveBeenCalled();
    expect(sidebar.textContent).not.toContain("Excluded latest title");

    catalog.hosts[0]!.sessions[0]!.name = "Own latest title";
    await publish();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sidebar.textContent).toContain("Own latest title");

    excluded.error = { code: "UNAVAILABLE", message: "Another host is unavailable" };
    await publish();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dom.attr(`${catalogSelector} .sidebar-session-group-toggle`, "aria-label")).toContain(
      "Another host is unavailable",
    );

    excluded.nextCursor = "next-owner-filtered-page";
    await publish();
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(dom.query(".sidebar-session-catalog-load-more")).not.toBeNull();
  });

  it.each([false, true])("hides empty Other header (adopted: %s)", async (adopted) => {
    const ownKey = "agent:main:own-task";
    const catalogKey = "agent:main:catalog-task";
    const harness = createSessionsHarness("main", [ownKey, ...(adopted ? [catalogKey] : [])]);
    const result = harness.sessions.state.result!;
    result.owners = [ada, bob];
    for (const row of result.sessions) {
      row.owner = { actor: row.key === ownKey ? ada : bob };
    }
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    const dom = domProbe(sidebar);
    const row = { threadId: "other", name: "Other", sessionKey: adopted ? catalogKey : undefined };
    const page = catalogPage([row]);
    // Adoption replaces creator provenance with the loaded session's owner.
    page.catalogs[0]!.hosts[0]!.sessions[0]!.createdActor = adopted ? ada : bob;
    page.catalogs[0]!.hosts[0]!.nextCursor = "more-owner-filtered-sessions";
    page.catalogs[0]!.error = { code: "UNAVAILABLE", message: "Another host is unavailable" };
    sidebar.sessionData.sessionCatalogs = page.catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await settleLitElement(sidebar);
    const header = () =>
      dom.query('[data-session-section="ungrouped"] .sidebar-recent-sessions__head');
    expect(header()).not.toBeNull();
    expect(dom.query('[data-session-section="catalog:codex"]')).not.toBeNull();

    sidebar.setSessionOwnerFilter(ada.id);
    await sidebar.updateComplete;
    await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
    await sidebar.updateComplete;
    expect(dom.query(`[data-session-key="${ownKey}"]`)).not.toBeNull();
    expect(dom.query('[data-session-section="catalog:codex"]')).toBeNull();
    expect(header()).toBeNull();

    sidebar.setSessionOwnerFilter(null);
    await sidebar.updateComplete;
    await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
    await sidebar.updateComplete;
    expect(dom.query('[data-session-section="catalog:codex"]')).not.toBeNull();
    expect(header()).not.toBeNull();
  });

  it.each([
    { owner: "the advertised catalog capability", scopes: undefined },
    { owner: "catalog read authority", scopes: ["operator.sessions.write"] },
  ])("retires catalogs after losing $owner", async ({ scopes }) => {
    vi.useFakeTimers();
    const firstPage = catalogPage([{ threadId: "thread-1", name: "Retired session" }], "page-2");
    firstPage.catalogs[0]!.capabilities.startTerminal = true;
    const expandedPage = catalogPage([{ threadId: "thread-2", name: "Retired page" }]);
    expandedPage.catalogs[0]!.capabilities.startTerminal = true;
    const request = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(expandedPage);
    const hello = { ...gatewayHelloForMethods(["sessions.catalog.list"]), protocol: 1 };
    const client = { request } as unknown as GatewayBrowserClient;
    const { sidebar, gateway } = await mountCatalog(client, { snapshot: { hello } });
    const dom = domProbe(sidebar);

    await sidebar.sessionData.loadMoreSessionCatalog("codex");
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Retired session");
    expect(sidebar.textContent).toContain("Retired page");
    expect(dom.query(".sidebar-session-catalog-new")).not.toBeNull();
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

    gateway.publish({ phase: "reconnecting", hello: null });
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Retired page");
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(1);

    gateway.publish({
      phase: "connected",
      hello: scopes
        ? { ...hello, auth: { role: "operator", scopes } }
        : { ...hello, features: { ...hello.features, methods: [] } },
    });
    await sidebar.updateComplete;
    await settleCatalog(sidebar);

    expect(sidebar.sessionData.sessionCatalogAgentId).toBeNull();
    expect(sidebar.sessionData.sessionCatalogs).toEqual([]);
    expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);
    expect(sidebar.textContent).not.toMatch(/Retired (session|page)/);
    expect(dom.query(".sidebar-session-catalog-new")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
