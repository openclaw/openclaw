import { For, flush, getOwner } from "solid-js";
import { expect, it } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "../test-helpers/load-styles.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { renderRecentSession as RecentSession } from "./app-sidebar-session-row-render.tsx";
import { AppSidebarOwner, type AppSidebarElement } from "./app-sidebar.tsx";
import { restoreSnapshotSession, snapshotSessions } from "./sidebar-snapshot-model.ts";

it("measures 33 cached rows with and without visible badge facts", () => {
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", []),
  );
  // SAFETY: the registered sidebar host supplies its native property contract.
  const props = document.createElement("openclaw-app-sidebar") as AppSidebarElement;
  const host = new AppSidebarOwner({ dashboards: null, loadMoreDashboards() {} }, context, props);
  host.sidebarAgentsMode = "chip";
  host.sessionPullRequests = {
    summary: (_key, _worktree, initial) => initial,
    count: () => undefined,
  };
  const saved = snapshotSessions(
    Array.from({ length: 33 }, (_, index) => ({
      ...projectSidebarSession({
        key: `agent:main:cached-${index}`,
        label: `Cached row ${index}`,
        unread: true,
      }),
      pullRequest: { numbers: [100 + index], state: "open" as const },
    })),
    (row) => ({ state: { pullRequest: row.pullRequest } }),
  );
  const cases = {
    facts: saved.map((row) => restoreSnapshotSession(row, "")),
    empty: saved.map((row) => restoreSnapshotSession({ ...row, state: undefined }, "")),
  };
  const output: Record<
    keyof typeof cases,
    {
      mountMs: number;
      layoutMs: number;
      owners: Record<string, number>;
      elements: number;
      svgs: number;
      height: number;
    }[]
  > = { facts: [], empty: [] };
  for (let pair = 0; pair < 13; pair++) {
    for (const name of pair % 2 ? (["facts", "empty"] as const) : (["empty", "facts"] as const)) {
      const container = document.body.appendChild(document.createElement("div"));
      container.className = "sidebar";
      container.style.width = "260px";
      const start = performance.now();
      let owner: ReturnType<typeof getOwner> = null;
      const mounted = mountSolid(
        () => {
          owner = getOwner();
          return (
            <For each={cases[name]}>{(row) => <RecentSession host={host} session={row} />}</For>
          );
        },
        { container },
      );
      flush();
      const mountedAt = performance.now();
      const layoutStart = performance.now();
      const rect = container.getBoundingClientRect();
      const layoutMs = performance.now() - layoutStart;
      const owners: Record<string, number> = {};
      const countOwners = (parent: ReturnType<typeof getOwner>) => {
        for (let child = parent?._firstChild; child; child = child._nextSibling) {
          const kind = child._name ?? "unnamed";
          owners[kind] = (owners[kind] ?? 0) + 1;
          countOwners(child);
        }
      };
      countOwners(owner);
      const elements = container.querySelectorAll("*").length;
      const svgs = container.querySelectorAll("svg").length;
      const rows = container.querySelectorAll(".sidebar-recent-session").length;

      expect(rows).toBe(33);
      expect(container.querySelectorAll('[data-pull-request-state="open"]')).toHaveLength(
        name === "facts" ? 33 : 0,
      );
      if (pair > 1)
        output[name].push({
          mountMs: mountedAt - start,
          layoutMs,
          owners,
          elements,
          svgs,
          height: rect.height,
        });
      mounted.unmount();
      container.remove();
    }
  }
  console.log("L218_CACHED_33_ROWS", JSON.stringify(output));
  expect(output.facts.map((sample) => sample.svgs)).toEqual(
    output.empty.map((sample) => sample.svgs),
  );
  expect(output.facts.map((sample) => sample.height)).toEqual(
    output.empty.map((sample) => sample.height),
  );
});
