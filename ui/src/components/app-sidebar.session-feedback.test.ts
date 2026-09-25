/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogListResult } from "../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import {
  mountRoster,
  selectFilter,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import {
  catalogPage,
  createGateway,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "./app-sidebar-session-types.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.ts";

const hint = "No active sessions match this filter";
const pagination = ".sidebar-session-pagination--roster button";

describe("sidebar session feedback", () => {
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
    await vi.waitFor(() => expect(sidebar.querySelector(pagination)).not.toBeNull());
    let pending = createDeferred<typeof first>();
    harness.list.mockClear();
    harness.list.mockImplementation(async () => await pending.promise);
    const button = () => sidebar.querySelector<HTMLButtonElement>(pagination)!;
    expect(button().disabled).toBe(false);
    button().click();
    button().click(); // The owner is already pending before Lit applies disabled.
    await sidebar.updateComplete;
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
    await sidebar.updateComplete;
    expect(sidebar.querySelectorAll("[data-session-key]")).toHaveLength(keys.length);
    pending.reject(new Error("Fixture page failed"));
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(button().textContent).toContain("Load more sessions");
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect(sidebar.textContent).toContain("Fixture page failed");
    pending = createDeferred<typeof first>();
    button().click();
    await sidebar.updateComplete;
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
    const { sidebar, gatewayHarness, request } = await mountRoster(undefined, []);
    await selectFilter(sidebar, "owner:profile-ada");
    await vi.waitFor(() => expect(sidebar.textContent).toContain(hint));
    let pending = createDeferred<SessionsCatalogListResult>();
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, ...args) =>
      method === "sessions.catalog.list" ? pending.promise : original(method, ...args),
    );
    gatewayHarness.publish({
      hello: {
        ...gatewayHarness.gateway.snapshot.hello!,
        features: { methods: ["sessions.catalog.list"] },
      },
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.catalog.list", expect.anything()),
    );
    await sidebar.updateComplete;
    expect(sidebar.textContent).not.toContain(hint);
    const initialScan = pending;
    pending = createDeferred<SessionsCatalogListResult>();
    initialScan.resolve(catalogPage([], "fixture-next"));
    await vi.waitFor(() => expect(sidebar.sessionData.loadingMoreSessionCatalogIds.size).toBe(1));
    await sidebar.updateComplete;
    expect(sidebar.textContent).not.toContain(hint);
    pending.resolve(catalogPage([]));
    await vi.waitFor(() => expect(sidebar.textContent).toContain(hint));
    pending = createDeferred<SessionsCatalogListResult>();
    const refresh = sidebar.sessionData.refreshSessionCatalogs();
    await sidebar.updateComplete;
    expect(sidebar.textContent).not.toContain(hint);
    const catalogs: SessionsCatalogListResult["catalogs"] = [
      {
        id: "fixture",
        label: "Fixture catalog",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:fixture",
            label: "Fixture host",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "fixture-thread",
                name: "Catalog conversation",
                status: "stored",
                archived: false,
                createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
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
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    expect(sidebar.textContent).not.toContain(hint);
  });

  it.each(["matching", "empty"] as const)(
    "waits for a pending catalog host to publish its %s result",
    async (outcome) => {
      const { sidebar, gatewayHarness, request } = await mountRoster(undefined, []);
      await selectFilter(sidebar, "owner:profile-ada");
      await vi.waitFor(() => expect(sidebar.textContent).toContain(hint));
      const catalog: SessionsCatalogListResult["catalogs"][number] = {
        id: "fixture",
        label: "Fixture catalog",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "node:fixture",
            label: "Fixture host",
            kind: "node",
            connected: true,
            pending: true,
            sessions: [],
          },
        ],
      };
      const original = request.getMockImplementation()!;
      request.mockImplementation((method, ...args) =>
        method === "sessions.catalog.list"
          ? Promise.resolve({ catalogs: [catalog] })
          : original(method, ...args),
      );
      gatewayHarness.publish({
        hello: {
          ...gatewayHarness.gateway.snapshot.hello!,
          features: { methods: ["sessions.catalog.list"] },
        },
      });
      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      const params = request.mock.calls.findLast(
        ([method]) => method === "sessions.catalog.list",
      )?.[1];
      expect(params).toMatchObject({
        agentId: "main",
        allowPartialResults: true,
        progressId: expect.any(String),
      });
      expect(sidebar.textContent).not.toContain(hint);

      gatewayHarness.publishEvent("sessions.catalog.host", {
        progressId: (params as { progressId: string }).progressId,
        agentId: "main",
        catalog: {
          ...catalog,
          hosts: [
            {
              ...catalog.hosts[0]!,
              pending: false,
              sessions:
                outcome === "matching"
                  ? [
                      {
                        threadId: "fixture-thread",
                        name: "Catalog conversation",
                        status: "stored",
                        archived: false,
                        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                        canContinue: true,
                        canArchive: false,
                      },
                    ]
                  : [],
            },
          ],
        },
      });
      await sidebar.updateComplete;
      if (outcome === "matching") {
        expect(sidebar.textContent).toContain("Catalog conversation");
        expect(sidebar.textContent).not.toContain(hint);
      } else {
        expect(sidebar.textContent).toContain(hint);
      }
    },
  );

  describe.each(["chip", "roster"] as const)("%s personal filter", (mode) => {
    it.each(["owner:profile-ada", "involving-me"])(
      "explains settled empty %s and preserves recovery",
      async (filter) => {
        const { sidebar, context, result } = await mountRoster(undefined, []);
        sidebar.sidebarAgentsMode = mode;
        for (const status of ["active", "archived", "all"]) {
          await selectFilter(sidebar, "status:" + status);
          expect(sidebar.textContent).not.toContain(hint);
        }
        await selectFilter(sidebar, "status:active");
        await selectFilter(sidebar, filter);
        await vi.waitFor(() => expect(sidebar.textContent).toContain(hint));
        if (mode === "chip") {
          expect(sidebar.querySelectorAll("[data-session-section]")).toHaveLength(0);
        }
        for (const status of ["archived", "all"] as const) {
          await selectFilter(sidebar, "status:" + status);
          expect(sidebar.textContent).not.toContain(hint);
        }
        await selectFilter(sidebar, "status:active");
        await vi.waitFor(() => expect(sidebar.textContent).toContain(hint));
        if (mode === "roster") {
          result.hasMore = true;
          await rosterActivityStore(context).refresh();
        } else {
          sidebar.sessionData.sessionsResult = {
            ...sidebar.sessionData.sessionsResult!,
            hasMore: true,
          };
          sidebar.requestUpdate();
        }
        await sidebar.updateComplete;
        expect(sidebar.textContent).not.toContain(hint);
        if (mode === "chip") {
          sidebar.querySelector<HTMLButtonElement>(".sidebar-session-filter-summary")!.click();
        } else {
          await selectFilter(sidebar, "owner:");
        }
        await sidebar.updateComplete;
        expect(sidebar.textContent).not.toContain(hint);
      },
    );

    it.each(["owner:profile-ada", "involving-me"])(
      "does not claim no matches before initial data, during refresh, or after a list error (%s)",
      async (filter) => {
        const { sidebar, context, request, sessions } = await mountRoster(undefined, []);
        sidebar.sidebarAgentsMode = mode;
        await selectFilter(sidebar, filter);
        await vi.waitFor(() => expect(sidebar.textContent).toContain(hint));
        const pending = createDeferred<never>();
        if (mode === "roster") {
          request.mockImplementation(async () => await pending.promise);
        } else {
          sessions.list.mockImplementation(async () => await pending.promise);
        }
        const refresh =
          mode === "roster"
            ? rosterActivityStore(context).refresh()
            : sidebar.sessionData.refreshSidebarSessions();
        await sidebar.updateComplete;
        expect(sidebar.textContent).not.toContain(hint);
        pending.reject(new Error("Fixture list failed"));
        await refresh;
        await sidebar.updateComplete;
        expect(sidebar.textContent).not.toContain(hint);
        if (mode === "chip") {
          sidebar.sessionData.sessionsResult = null;
          sidebar.sessionData.sessionMutationError = null;
          sidebar.requestUpdate();
          await sidebar.updateComplete;
          expect(sidebar.textContent).not.toContain(hint);
        }
      },
    );
  });
});
