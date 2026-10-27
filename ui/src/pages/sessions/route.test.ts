// @vitest-environment node

import { createRouter, type RouteLoaderOptions } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionListOptions } from "../../lib/sessions/index.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { buildSessionsListQuery } from "./list-query.ts";
import { page, type SessionsRouteData } from "./route.ts";

async function loadSessionsRoute(
  search: string,
  scopeId: string | null,
  expectedQuery: Partial<SessionListOptions>,
) {
  const sessions = { list: vi.fn(), listSnapshot: vi.fn(), refreshList: vi.fn() };
  const context = {
    gateway: { snapshot: { phase: "connected", client: {} } },
    router: { getState: () => ({ matches: [{ routeId: "sessions" }] }) },
    sessions,
    agentSelection: { state: { selectedId: scopeId, scopeId } },
  } as unknown as ApplicationContext;
  const loaderOptions: RouteLoaderOptions = createRouteLoaderOptions({
    pathname: "/sessions",
    search,
    hash: "",
  });

  const data = (await page.loader?.(context, loaderOptions)) as SessionsRouteData;
  await page.loader?.(context, { ...loaderOptions, cause: "revalidate", revalidating: true });

  for (const request of Object.values(sessions)) {
    expect(request).not.toHaveBeenCalled();
  }
  expect(data).toEqual({
    expandedSessionKey: expectedQuery.search ?? null,
    statusFilter: expectedQuery.archivedFilter,
  });
  expect(
    buildSessionsListQuery(
      context.agentSelection.state.scopeId,
      {
        statusFilter: data.statusFilter,
        includeGlobal: true,
        includeUnknown: false,
        limit: "50",
      },
      data.expandedSessionKey,
    ),
  ).toEqual({
    source: "sessions-page",
    rowMode: "compact",
    excludeDock: !data.expandedSessionKey,
    limit: 50,
    includeGlobal: true,
    includeUnknown: false,
    includeDerivedTitles: false,
    includeLastMessage: false,
    ...expectedQuery,
  });
}

it.each([
  ["", "writer", { archivedFilter: "active", agentId: "writer" }],
  ["?status=archived", null, { archivedFilter: "archived" }],
  ["?status=all", "main", { archivedFilter: "all", agentId: "main" }],
  [
    "?session=agent%3Aresearch%3Alinked",
    "main",
    {
      search: "agent:research:linked",
      includeUnknown: true,
      archivedFilter: "active",
      agentId: "research",
    },
  ],
] as const)(
  "leaves same-route navigation and revalidation %s in scope %s with the page owner",
  loadSessionsRoute,
);

it("starts the entering Sessions query while its route module is still loading", async () => {
  type RouteModule = Awaited<ReturnType<typeof page.component>>;
  const module = createDeferred<RouteModule>();
  const refreshList = vi.fn(async () => {});
  const router = createRouter<
    "chat" | "sessions",
    ApplicationContext,
    RouteModule,
    SessionsRouteData
  >({
    routes: [
      { id: "chat", path: "/chat", component: () => ({ renderSolid: () => null }) },
      { ...page, component: () => module.promise },
    ],
  });
  // SAFETY: The real router and route loader only consume these application owners.
  const context = {
    router,
    sessions: { refreshList },
    agentSelection: { state: { scopeId: "writer" } },
  } as unknown as ApplicationContext;
  let navigation: Promise<void> | undefined;
  try {
    await router.navigate("chat", context);
    navigation = router.navigate("sessions", context);
    expect(refreshList).toHaveBeenCalledExactlyOnceWith({
      source: "sessions-page",
      excludeDock: true,
      rowMode: "compact",
      limit: 50,
      includeGlobal: true,
      includeUnknown: false,
      includeDerivedTitles: false,
      includeLastMessage: false,
      archivedFilter: "active",
      agentId: "writer",
    });
    expect(router.getState().status).toBe("loading");
    module.resolve({ renderSolid: () => null });
    await navigation;
    expect(router.getState().matches[0]?.routeId).toBe("sessions");
    expect(router.getState().status).toBe("success");
  } finally {
    module.resolve({ renderSolid: () => null });
    await navigation;
    router.stop();
  }
});

it.each([
  [" 15 ", "25", "active", undefined, [15, 25, "needle"]],
  ["15 minutes", "0", "active", undefined, [undefined, 50, "needle"]],
  ["15", "25", "archived", "", [undefined, 25, undefined]],
] as const)(
  "normalizes minutes=%s limit=%s status=%s search=%s",
  (activeMinutes, limit, statusFilter, search, expected) => {
    const query = buildSessionsListQuery(
      "writer",
      {
        activeMinutes,
        limit,
        statusFilter,
        includeGlobal: true,
        includeUnknown: false,
        searchQuery: " needle ",
      },
      null,
      search,
    );
    expect([query.activeMinutes, query.limit, query.search]).toEqual(expected);
  },
);
