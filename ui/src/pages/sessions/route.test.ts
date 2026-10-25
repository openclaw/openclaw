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
    runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
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
  {
    name: "numeric form text",
    activeMinutes: " 15 ",
    limit: "25",
    statusFilter: "active",
    search: undefined,
    expected: { activeMinutes: 15, limit: 25, search: "needle" },
  },
  {
    name: "invalid numbers",
    activeMinutes: "15 minutes",
    limit: "0",
    statusFilter: "active",
    search: undefined,
    expected: { activeMinutes: undefined, limit: 50, search: "needle" },
  },
  {
    name: "archived rows with an explicitly cleared search",
    activeMinutes: "15",
    limit: "25",
    statusFilter: "archived",
    search: "",
    expected: { activeMinutes: undefined, limit: 25, search: undefined },
  },
] as const)("normalizes $name at the list-query boundary", (testCase) => {
  const query = buildSessionsListQuery(
    "writer",
    {
      activeMinutes: testCase.activeMinutes,
      limit: testCase.limit,
      statusFilter: testCase.statusFilter,
      includeGlobal: true,
      includeUnknown: false,
      searchQuery: " needle ",
    },
    null,
    testCase.search,
  );
  expect({ activeMinutes: query.activeMinutes, limit: query.limit, search: query.search }).toEqual(
    testCase.expected,
  );
});
