/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { patchSettings } from "../app/settings.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { sessionMenu } from "../test-helpers/app-sidebar-cases/multi-select-support.ts";
import {
  mountRoster,
  owners,
  selectFilter,
  sessionKeys,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import {
  catalogPage,
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { registerSessionPluginAction } from "../test-helpers/control-ui-plugin-action.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { menuItemLabels, openSubmenu } from "../test-helpers/session-menu.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  SIDEBAR_SESSION_PAGE_SIZE,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";
import "./app-sidebar.tsx";

const hint = "No active sessions match this filter";
const pagination = ".sidebar-session-pagination--roster button";
type Roster = Awaited<ReturnType<typeof mountRoster>>;

async function expectHint(sidebar: Roster["sidebar"], visible = false) {
  await settleLitElement(sidebar);
  expect(sidebar.textContent?.includes(hint)).toBe(visible);
}

async function selectStatus(sidebar: Roster["sidebar"], status: string) {
  await selectFilter(sidebar, `status:${status}`);
  const input = sidebar.querySelector<HTMLInputElement>(
    `#sidebar-sessions-status input[value="${status}"]`,
  );
  expect(input?.checked).toBe(true);
  expect(sidebar.textContent).not.toContain(hint);
}

async function emptyCatalogFixture() {
  const fixture = await mountRoster(undefined, []);
  await selectFilter(fixture.sidebar, "owner:profile-ada");
  await vi.waitFor(() => expect(fixture.sidebar.textContent).toContain(hint));
  const enableCatalog = () =>
    fixture.gatewayHarness.publish({
      hello: {
        ...fixture.gatewayHarness.gateway.snapshot.hello!,
        features: { methods: ["sessions.catalog.list"] },
      },
    });
  const original = fixture.request.getMockImplementation()!;
  const reply = (read: () => Promise<SessionsCatalogListResult>) =>
    fixture.request.mockImplementation((method, ...args) =>
      method === "sessions.catalog.list" ? read() : original(method, ...args),
    );
  return { ...fixture, enableCatalog, reply };
}

function matchingCatalog(): SessionsCatalogListResult {
  const page = catalogPage([{ threadId: "fixture-thread", name: "Catalog conversation" }]);
  const catalog = page.catalogs[0]!;
  catalog.capabilities.archive = false;
  Object.assign(catalog.hosts[0]!.sessions[0]!, {
    status: "stored",
    canArchive: false,
    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
  });
  return page;
}

// Roster mode renders the owner filter from the roster's own list. Let that first
// load settle so the Filter & sort owner picker is not replaced while in use.
async function useSidebarMode(
  sidebar: Roster["sidebar"],
  context: Roster["context"],
  mode: "chip" | "roster",
) {
  sidebar.sidebarAgentsMode = mode;
  await settleLitElement(sidebar);
  if (mode === "roster") {
    await vi.waitFor(() =>
      expect(rosterActivityStore(context).snapshot).toMatchObject({
        loading: false,
        result: expect.anything(),
      }),
    );
    await settleLitElement(sidebar);
  }
}

describe("sidebar session feedback", () => {
  it.each([false, true])(
    "uses only the roster membership read in roster mode (involvingMe=%s)",
    async (involvingMe) => {
      const viewer = "profile-ada";
      const groups = ["Planning", "Research"];
      const sectionOrder = ["category:Research", "category:Planning"];
      const rows: GatewaySessionRow[] = (
        [
          ["mine", "My project", viewer],
          ["involved", "Shared project", "profile-sam"],
          ["other", "Other project", "profile-sam"],
        ] as const
      ).map(([id, label, ownerId], index) => ({
        key: `agent:main:${id}`,
        agentId: "main",
        sessionId: id,
        kind: "direct",
        label,
        updatedAt: 3 - index,
        lastAssistantMessage: { text: `${label} update`, timestamp: index + 1 },
        owner: { actor: { type: "human", id: ownerId } },
      }));
      let failRoster = false;
      const request = createGatewayRequestMock(async (method, raw) => {
        const params = raw as Record<string, unknown> | undefined;
        if (method === "sessions.list") {
          if (failRoster && params?.source === "agent-roster") {
            throw new Error("Fixture roster unavailable");
          }
          const selected = params?.spawnedBy
            ? []
            : rows.filter(
                (row) =>
                  (!params?.ownerId || row.owner?.actor.id === params.ownerId) &&
                  (!params?.involvingMe || row.key !== "agent:main:other"),
              );
          return {
            ...sessionsResult(selected, 1),
            owners,
            hasMore: false,
            nextOffset: null,
          };
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.groups.list") {
          return { groups: groups.map((name, position) => ({ name, position })), sectionOrder };
        }
        if (method === "sessions.describe") {
          return { session: rows.find((row) => row.key === params?.key) ?? null };
        }
        return {};
      });
      const gateway = createGatewayHarness(createTestGatewayClient(request));
      gateway.publish({
        selfUser: { id: viewer, name: "Ada" },
        hello: {
          ...gateway.gateway.snapshot.hello!,
          features: {
            methods: [
              ...gateway.gateway.snapshot.hello!.features!.methods!,
              "sessions.groups.list",
            ],
          },
        },
      });
      patchSettings({
        gatewayUrl: gateway.gateway.connection.gatewayUrl,
        sidebarAgentsMode: "roster",
      });
      storeSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, viewer, {
        ownerId: involvingMe ? null : viewer,
        involvingMe,
      });
      const sessions = createTestSessionCapability(gateway.gateway);
      const { sidebar, context, provider } = await mountSidebar(
        gateway.gateway,
        sessions,
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "Harbor" }],
        },
      );
      const plugin = registerSessionPluginAction(context, {
        id: "review",
        label: "Review session",
        placement: "session",
        resolve: ({ session }) => ({ label: `Review ${session?.label}` }),
        run: async () => {},
      });
      const filteredSidebarReads = () =>
        request.mock.calls.flatMap(([method, raw]) => {
          const params = raw as Record<string, unknown> | undefined;
          return method === "sessions.list" &&
            params?.source === "sidebar" &&
            (params.ownerId || params.involvingMe)
            ? [params]
            : [];
        });
      const expectedKeys = involvingMe
        ? ["agent:main:mine", "agent:main:involved"]
        : ["agent:main:mine"];
      const expectRoster = () => {
        expect(sidebar.querySelector(".sidebar-agent-roster__preview")?.textContent).toBe(
          involvingMe ? "Shared project update" : "Other project update",
        );
        expect(sessionKeys(sidebar)).toEqual([]);
      };
      try {
        sidebar.connected = true;
        sidebar.setSessionSortMode("updated");
        await settleLitElement(sidebar);
        await vi.waitFor(expectRoster);
        expect.soft(filteredSidebarReads()).toEqual([]);
        await vi.waitFor(() => expect(sessions.state.groups).toEqual(groups));
        expect.soft(sidebar.knownSessionGroups()).toEqual(groups);
        expect.soft(sidebar.knownSectionOrder()).toEqual(sectionOrder);

        const menuSession = sidebar.findSidebarMenuSessionByKey("agent:main:mine");
        expect(menuSession).toBeDefined();
        sidebar.sidebarMenus.openSessionMenu(menuSession!, 0, 0);
        await settleLitElement(sidebar);
        const menu = await sessionMenu(sidebar);
        expect.soft(menuItemLabels(menu)).toContain("Review My project");
        const groupMenu = await openSubmenu(menu, "Move to group");
        expect.soft(menuItemLabels(groupMenu)).toEqual(expect.arrayContaining(groups));
        sidebar.sidebarMenus.closeSessionMenu();

        sidebar.sidebarAgentsMode = "chip";
        await settleLitElement(sidebar);
        await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual(expectedKeys));
        expect(filteredSidebarReads().length).toBeGreaterThan(0);
        request.mockClear();

        sidebar.sidebarAgentsMode = "roster";
        await settleLitElement(sidebar);
        await vi.waitFor(expectRoster);
        expect(sidebar.sidebarSessionOwnerFilter()).toEqual({
          ownerId: involvingMe ? null : viewer,
          involvingMe,
        });
        expect.soft(filteredSidebarReads()).toEqual([]);

        failRoster = true;
        await rosterActivityStore(context).refresh();
        await settleLitElement(sidebar);
        expect(sidebar.querySelector(".sidebar-agent-roster__link")).not.toBeNull();
        failRoster = false;
        await rosterActivityStore(context).refresh();
        await settleLitElement(sidebar);
        expect(sidebar.querySelector(".sidebar-agent-roster__link")).toBeNull();
        expectRoster();

        sidebar.setSessionOwnerFilter(null);
        sidebar.sidebarAgentsMode = "chip";
        await settleLitElement(sidebar);
        await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual(rows.map((row) => row.key)));
        expect(sidebar.knownSessionGroups()).toEqual(groups);
        expect(sidebar.knownSectionOrder()).toEqual(sectionOrder);
      } finally {
        plugin.lifetime.abort();
        provider.remove();
        context.connectionBootstrap.reset();
        sessions.dispose();
      }
    },
  );

  it("shows pending append, blocks repeated activation, and recovers after failure and retry", async () => {
    const keys = Array.from(
      { length: SIDEBAR_SESSION_PAGE_SIZE + 1 },
      (_, i) => "agent:main:thread-" + i,
    );
    const harness = createSessionsHarness("main", keys);
    const first = { ...harness.sessions.state.result!, hasMore: true, nextOffset: keys.length };
    harness.list.mockResolvedValue(first);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    await selectFilter(sidebar, "status:all");
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = keys[0]!;
    await settleLitElement(sidebar);
    await vi.waitFor(() => expect(sidebar.querySelector(pagination)).not.toBeNull());
    const button = () => sidebar.querySelector<HTMLButtonElement>(pagination)!;
    const focusedButton = button();
    focusedButton.focus();
    sidebar.sessionKey = keys[1]!;
    await settleLitElement(sidebar);
    expect(button()).toBe(focusedButton);
    expect(document.activeElement).toBe(focusedButton);
    let pending = createDeferred<typeof first>();
    harness.list.mockClear();
    harness.list.mockImplementation(async () => await pending.promise);
    expect(button().disabled).toBe(false);
    button().click();
    button().click(); // The owner is already pending before the renderer applies disabled.
    await settleLitElement(sidebar);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    button().click();
    await sidebar.sessionData.loadMoreSidebarSessions();
    expect(harness.list).toHaveBeenCalledTimes(1);
    expect(sidebar.querySelectorAll("[data-session-key]")).toHaveLength(SIDEBAR_SESSION_PAGE_SIZE);
    expect(button().textContent).toContain("Loading");
    const localMore = sidebar.querySelector<HTMLButtonElement>('button[aria-label="Show more"]')!;
    expect(localMore.disabled).toBe(false);
    localMore.click();
    await settleLitElement(sidebar);
    expect(sidebar.querySelectorAll("[data-session-key]")).toHaveLength(keys.length);
    pending.reject(new Error("Fixture page failed"));
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(button().textContent).toContain("Load more sessions");
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect(sidebar.textContent).toContain("Fixture page failed");
    pending = createDeferred<typeof first>();
    button().click();
    await settleLitElement(sidebar);
    expect(button().disabled).toBe(true);
    expect(harness.list).toHaveBeenCalledTimes(2);
    pending.resolve({
      ...first,
      hasMore: false,
      nextOffset: keys.length + 1,
      sessions: [{ key: "agent:main:last", kind: "direct", updatedAt: 1 }],
    });
    await vi.waitFor(() => expect(sidebar.querySelector(pagination)).toBeNull());
    expect(sidebar.querySelector('[data-session-key="agent:main:last"]')).not.toBeNull();
  });

  it("waits for catalog hydration, refresh, and hidden pages before explaining an empty list", async () => {
    const { sidebar, request, enableCatalog, reply } = await emptyCatalogFixture();
    let pending = createDeferred<SessionsCatalogListResult>();
    reply(() => pending.promise);
    enableCatalog();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.catalog.list", expect.anything()),
    );
    await expectHint(sidebar);
    const initialScan = pending;
    pending = createDeferred<SessionsCatalogListResult>();
    initialScan.resolve(catalogPage([], "fixture-next"));
    await vi.waitFor(() => expect(sidebar.sessionData.loadingMoreSessionCatalogIds.size).toBe(1));
    await expectHint(sidebar);
    pending.resolve(catalogPage([]));
    await vi.waitFor(() => expect(sidebar.textContent).toContain(hint));
    pending = createDeferred<SessionsCatalogListResult>();
    const refresh = sidebar.sessionData.refreshSessionCatalogs();
    await expectHint(sidebar);
    const catalogs = matchingCatalog().catalogs;
    pending.resolve({ catalogs });
    await refresh;
    await vi.waitFor(() => expect(sidebar.textContent).toContain("Catalog conversation"));
    expect(sidebar.textContent).not.toContain(hint);
    sidebar.sessionData.sessionCatalogs = catalogs.map((catalog) =>
      Object.assign({}, catalog, {
        hosts: catalog.hosts.map((host) =>
          Object.assign({}, host, { sessions: [], nextCursor: "fixture-next" }),
        ),
      }),
    );
    sidebar.invalidate();
    await expectHint(sidebar);
  });

  it("keeps the empty-list hint hidden while a catalog host is pending", async () => {
    const { sidebar, enableCatalog, reply } = await emptyCatalogFixture();
    const catalog = catalogPage([]).catalogs[0]!;
    catalog.capabilities.archive = false;
    Object.assign(catalog, { id: "fixture", label: "Fixture catalog" });
    Object.assign(catalog.hosts[0]!, {
      hostId: "node:fixture",
      label: "Fixture host",
      kind: "node",
      pending: true,
    });
    reply(async () => ({ catalogs: [catalog] }));
    enableCatalog();
    await sidebar.sessionData.refreshSessionCatalogs();
    await settleLitElement(sidebar);
    expect(sidebar.textContent).not.toContain(hint);
  });

  it.each([
    { mode: "chip", filter: "involving-me", failure: false },
    { mode: "roster", filter: "owner:profile-ada", failure: false },
    { mode: "roster", filter: "owner:profile-ada", failure: true },
  ] as const)(
    "limits settled empty-session feedback to session mode ($mode, $filter, failure=$failure)",
    async ({ mode, filter, failure }) => {
      const { sidebar, context, result, sessions } = await mountRoster(undefined, []);
      await useSidebarMode(sidebar, context, mode);
      if (!failure) {
        for (const status of ["active", "archived", "all"]) {
          await selectStatus(sidebar, status);
        }
        await selectFilter(sidebar, "status:active");
      }
      await selectFilter(sidebar, filter);
      await expectHint(sidebar, mode === "chip");
      if (failure) {
        const pending = createDeferred<never>();
        sessions.list.mockImplementation(async () => await pending.promise);
        const refresh = rosterActivityStore(context).refresh();
        await expectHint(sidebar);
        pending.reject(new Error("Fixture list failed"));
        await refresh;
        await expectHint(sidebar);
      } else {
        if (mode === "chip") {
          expect(sidebar.querySelectorAll("[data-session-section]")).toHaveLength(0);
        }
        for (const status of ["archived", "all"] as const) {
          await selectStatus(sidebar, status);
        }
        await selectFilter(sidebar, "status:active");
        await expectHint(sidebar, mode === "chip");
        if (mode === "roster") {
          result.hasMore = true;
          await rosterActivityStore(context).refresh();
        } else {
          sidebar.sessionData.sessionsResult = {
            ...sidebar.sessionData.sessionsResult!,
            hasMore: true,
          };
          sidebar.invalidate();
        }
        await expectHint(sidebar);
        await selectFilter(sidebar, "owner:");
        await expectHint(sidebar);
      }
    },
  );
});
