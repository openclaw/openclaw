// @vitest-environment node

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
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
    sessions,
    agentSelection: { state: { selectedId: scopeId, scopeId } },
  } as unknown as ApplicationContext;
  const loaderOptions: RouteLoaderOptions = createRouteLoaderOptions({
    pathname: "/sessions",
    search,
    hash: "",
  });

  const data = (await page.loader?.(context, loaderOptions)) as SessionsRouteData;

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
  "prepares sessions route %s in scope %s without issuing outside the page owner",
  loadSessionsRoute,
);

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
