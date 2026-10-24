import { expect, it } from "vitest";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import {
  mountRoster,
  roster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import { SidebarAgentRoster } from "./sidebar-agent-roster.tsx";
import "../test-helpers/load-styles.ts";

setupSidebarTest();

it("indexes sections once across a large mounted roster", async () => {
  const agents = Array.from({ length: 40 }, (_, i) => ({
    id: i === 0 ? "main" : `agent-${i}`,
    name: `Agent ${i}`,
  }));
  const { sidebar, context } = await mountRoster({ ...roster, agents });
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);
  let sectionReads = 0;
  let summaryRowReads = 0;
  const sections: SidebarVisibleSections["sections"] = agents.flatMap((agent) =>
    Array.from({ length: 4 }, (_, i) => ({
      get id(): `agent:${string}` {
        sectionReads++;
        return `agent:${agent.id}:category-${i}`;
      },
      get rows() {
        summaryRowReads++;
        return [];
      },
      totalRowCount: 0,
      visibleRowCount: 0,
      visibleLimit: 10,
      collapsedVisibleRowCount: 0,
      renderHeader: false,
    })),
  );
  const owner = getAppSidebarOwner(sidebar.hostElement)!;
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SidebarAgentRoster host={owner} active={true} sections={sections} />
    </ApplicationProvider>
  ));
  await waitForSolid(() =>
    expect(mounted.container.querySelectorAll("[data-agent-group]")).toHaveLength(40),
  );
  expect.soft(sectionReads).toBeLessThanOrEqual(sections.length * 2);
  expect(summaryRowReads).toBeLessThanOrEqual(sections.length);
});
