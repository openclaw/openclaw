import type { RouteLoaderOptions } from "@openclaw/uirouter";
// @vitest-environment node
import { assert, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { sessionListResult } from "../../test-helpers/chat-model.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { page } from "./route.ts";

const loaderOptions: RouteLoaderOptions = createRouteLoaderOptions({
  pathname: "/dashboards",
  search: "",
  hash: "",
});

it.each([undefined, "global", "per-sender"] as const)(
  "seeds the managed dashboards query and configured scope %s",
  async (scope) => {
    const result = sessionListResult(1, []);
    let snapshot = {
      result: null as typeof result | null,
      agentId: null,
      loading: false,
      error: null,
    };
    const list = vi.fn();
    const listSnapshot = vi.fn(() => snapshot);
    const refreshList = vi.fn(async () => {
      snapshot = { ...snapshot, result };
    });
    const context = {
      basePath: "",
      sessions: { list, listSnapshot, refreshList },
      agentSelection: { state: { selectedId: "main", scopeId: null } },
      agents: {
        state: { agentsList: scope ? { defaultId: "main", mainKey: "main", scope } : null },
      },
      gateway: { snapshot: { hello: null } },
    } as unknown as ApplicationContext;

    const data = await page.loader!(context, loaderOptions);
    assert(!("type" in data), "Dashboards should load data without redirecting");
    expect(data.globalScope).toBe(scope === "global");

    const query = {
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      rowMode: "dashboard",
      source: "dashboard",
      excludeDock: true,
      hasBoard: true,
      archivedFilter: "all",
    };
    expect(refreshList).toHaveBeenCalledWith(query);
    expect(listSnapshot).toHaveBeenLastCalledWith(query);
    expect(list).not.toHaveBeenCalled();
  },
);
