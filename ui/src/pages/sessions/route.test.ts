// @vitest-environment jsdom

import { createRouter, type RouteLoaderOptions } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionListOptions } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { buildSessionsListQuery } from "./list-query.ts";
import { SessionsPagePreferencesState } from "./page-state.ts";
import { page, type SessionsRouteData } from "./route.ts";

async function loadSessionsRoute(options: {
  search: string;
  scopeId: string | null;
  expectedQuery: SessionListOptions;
}) {
  const list = vi.fn();
  const listSnapshot = vi.fn();
  const refreshList = vi.fn();
  const context = {
    gateway: { snapshot: { phase: "connected", client: {} } },
    sessions: { list, listSnapshot, refreshList },
    runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
    agentSelection: { state: { selectedId: options.scopeId, scopeId: options.scopeId } },
  } as unknown as ApplicationContext;
  const loaderOptions: RouteLoaderOptions = {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: { pathname: "/sessions", search: options.search, hash: "" },
    deps: "",
    cause: "navigation",
  };

  const data = (await page.loader?.(context, loaderOptions)) as SessionsRouteData;

  expect(refreshList).not.toHaveBeenCalled();
  expect(listSnapshot).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(data).toEqual({
    expandedSessionKey: options.expectedQuery.search ?? null,
    statusFilter: options.expectedQuery.archivedFilter,
  });
  expect(
    buildSessionsListQuery(context, {
      statusFilter: data.statusFilter,
      deepLinkSessionKey: data.expandedSessionKey,
      includeGlobal: true,
      includeUnknown: false,
      limit: 50,
    }),
  ).toEqual(options.expectedQuery);
}

describe("sessions route", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "default selected-agent roster",
      search: "",
      scopeId: "writer",
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active" as const,
        agentId: "writer",
      },
    },
    {
      name: "archived all-agent roster",
      search: "?status=archived",
      scopeId: null,
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "archived" as const,
      },
    },
    {
      name: "all-status selected-agent roster",
      search: "?status=all",
      scopeId: "main",
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "all" as const,
        agentId: "main",
      },
    },
    {
      name: "deep link owned by a different agent",
      search: "?session=agent%3Aresearch%3Alinked",
      scopeId: "main",
      expectedQuery: {
        limit: 50,
        search: "agent:research:linked",
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active" as const,
        agentId: "research",
      },
    },
  ])("prepares the $name without issuing outside the page owner", async (testCase) => {
    await loadSessionsRoute(testCase);
  });

  it("uses the persisted status for the initial roster", async () => {
    new SessionsPagePreferencesState().update({ statusFilter: "archived" });

    await loadSessionsRoute({
      search: "",
      scopeId: "writer",
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "archived",
        agentId: "writer",
      },
    });
  });

  it("keeps explicit status URLs ahead of persisted status", async () => {
    new SessionsPagePreferencesState().update({ statusFilter: "archived" });

    await loadSessionsRoute({
      search: "?status=all",
      scopeId: null,
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "all",
      },
    });
  });

  it("keeps direct-session links active and isolated from persisted status", async () => {
    new SessionsPagePreferencesState().update({ statusFilter: "archived" });

    await loadSessionsRoute({
      search: "?session=agent%3Aresearch%3Alinked",
      scopeId: "main",
      expectedQuery: {
        limit: 50,
        search: "agent:research:linked",
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active",
        agentId: "research",
      },
    });
  });

  it("reloads the stored status after an explicit Active visit", async () => {
    new SessionsPagePreferencesState().update({ statusFilter: "archived" });
    const context = {
      runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
      agentSelection: { state: { selectedId: "main", scopeId: "main" } },
    } as unknown as ApplicationContext;
    const router = createRouter<"sessions", ApplicationContext, null, SessionsRouteData>({
      routes: [{ ...page, component: () => null }],
    });
    const location = (search: string) => ({ pathname: "/sessions", search, hash: "" });

    try {
      await router.navigate("sessions", context, {}, location("?status=active"));
      expect(router.getState().matches[0]?.data?.statusFilter).toBe("active");

      await router.navigate("sessions", context, {}, location(""));
      expect(router.getState().matches[0]?.data?.statusFilter).toBe("archived");
    } finally {
      router.stop();
    }
  });
});
