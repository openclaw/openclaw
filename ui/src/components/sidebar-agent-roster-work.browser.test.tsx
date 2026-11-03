import { expect, it, vi } from "vitest";
import { patchSettings } from "../app/settings.ts";
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
import { SidebarScrollContext } from "./sidebar-context-controller.ts";
import "../test-helpers/load-styles.ts";

setupSidebarTest();

async function prepareRoster(count: number, pinnedAgentIds: string[] = []) {
  const agents = Array.from({ length: count }, (_, i) => ({
    id: i === 0 ? "main" : `agent-${i}`,
    name: `Agent ${i}`,
  }));
  const { sidebar, context } = await mountRoster({ ...roster, agents });
  if (pinnedAgentIds.length) {
    context.navigation.update({ pinnedAgentIds });
  }
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);
  return { agents, context, owner: getAppSidebarOwner(sidebar.hostElement)! };
}

async function mountViewport(pinnedAgentIds: string[] = []) {
  const { context, owner } = await prepareRoster(100, pinnedAgentIds);
  let viewport!: HTMLDivElement;
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <div
        ref={(element) => (viewport = element)}
        style={{ width: "280px", height: "230px", overflow: "auto" }}
      >
        <SidebarScrollContext
          value={{
            element: () => viewport,
            content: () => undefined,
            readAnchor: () => undefined,
            captureAnchor() {},
            subscribeScroll: () => () => {},
          }}
        >
          <SidebarAgentRoster host={owner} active={true} sections={[]} />
        </SidebarScrollContext>
      </div>
    </ApplicationProvider>
  ));
  return { ...mounted, viewport };
}

it("indexes sections once across a large mounted roster", async () => {
  const { agents, context, owner } = await prepareRoster(40);
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

it("mounts only viewport roster rows and retains the focused row while scrolling", async () => {
  const { viewport, ...mounted } = await mountViewport();
  const groups = () => mounted.container.querySelectorAll<HTMLElement>("[data-agent-group]");
  await waitForSolid(() => {
    expect(groups().length).toBeGreaterThan(0);
    expect(groups().length).toBeLessThan(12);
  });
  const first = groups()[0]!;
  const focused = first.querySelector<HTMLButtonElement>(".sidebar-agent-roster__action")!;
  focused.focus();
  await waitForSolid(() => expect(document.activeElement).toBe(focused));
  const height = viewport.scrollHeight;
  expect(height).toBeGreaterThan(4_000);
  viewport.scrollTop = height;
  viewport.dispatchEvent(new Event("scroll"));
  await waitForSolid(() => {
    expect(groups().length).toBeLessThan(12);
    expect(groups().item(groups().length - 1)?.dataset.agentGroup).toBe("agent-99");
    expect(first.isConnected).toBe(true);
    expect(document.activeElement).toBe(focused);
  });
  expect(viewport.scrollHeight).toBe(height);
  const { userEvent } = await import("vitest/browser");
  await userEvent.keyboard("{Tab}");
  expect(
    document.activeElement?.closest<HTMLElement>("[data-agent-group]")?.dataset.agentGroup,
  ).toBe("agent-1");
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event("scroll"));
  await waitForSolid(() => {
    expect(groups()[0]).toBe(first);
    expect(mounted.container.querySelector('[data-agent-group="agent-99"]')).toBeNull();
  });
});

it("restores focus when unpinning an agent outside the roster viewport", async () => {
  const mounted = await mountViewport(["agent-99"]);
  const pinned = mounted.container.querySelector<HTMLAnchorElement>(
    '[data-pinned-agent="agent-99"] a',
  )!;
  pinned.focus();
  pinned.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
  );
  await waitForSolid(() =>
    expect(mounted.container.querySelector('[data-value="pin"]')).not.toBeNull(),
  );
  mounted.container.querySelector<HTMLElement>('[data-value="pin"]')!.click();
  await waitForSolid(() => {
    const row = mounted.container.querySelector('[data-agent-group="agent-99"] a');
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(pinned.isConnected).toBe(false);
  });
});

it("retires inactive session body work across roster and chip mode changes", async () => {
  patchSettings({ gatewayUrl: "ws://gateway.test", sidebarAgentsMode: "roster" });
  const { sidebar, context } = await mountRoster(roster);
  await settleRoster(sidebar);
  await waitForSolid(() => expect(sidebar.querySelector("[data-agent-group]")).not.toBeNull());
  const owner = getAppSidebarOwner(sidebar.hostElement)!;
  const groups = vi.spyOn(owner, "personalGroupSessionRows");
  const body = sidebar.querySelector(".sidebar-shell__body");
  expect(body).not.toBeNull();
  const initialRoster = sidebar.querySelector("openclaw-sidebar-agent-roster");
  const record = (phase: string) =>
    console.log(
      "inactive-sidebar-counts",
      JSON.stringify({
        phase,
        groups: groups.mock.calls.length,
      }),
    );
  record("cold-roster");
  const update = async (phase: string, expectedGroups: number) => {
    groups.mockClear();
    for (let i = 0; i < 10; i++) {
      sidebar.devGitBranch = `${phase}-${i}`;
      await settleRoster(sidebar);
      expect(sidebar.textContent).toContain(`${phase}-${i}`);
    }
    record(phase);
    expect.soft(groups).toHaveBeenCalledTimes(expectedGroups);
  };
  await update("ten-cold-roster-updates", 0);

  sidebar.sidebarEntries = ["session:agent:main:pinned"];
  context.navigation.update({
    personalSessionGroups: [
      { id: "project", label: "Project", sessionKeys: ["agent:main:recent"] },
    ],
  });
  const expectRows = () => {
    expect(sidebar.querySelectorAll('[data-session-section="pinned"]')).toHaveLength(1);
    expect(sidebar.querySelectorAll('[data-personal-session-group="project"]')).toHaveLength(1);
    expect(sidebar.querySelectorAll('[data-session-key="agent:main:pinned"]')).toHaveLength(1);
    expect(
      sidebar.querySelectorAll(
        '[data-personal-session-group="project"] [data-session-key="agent:main:recent"]',
      ),
    ).toHaveLength(1);
  };
  await settleRoster(sidebar);
  await waitForSolid(expectRows);
  // Each group has owner bookkeeping.
  await update("ten-roster-updates-with-pins", 40);
  for (const [index, mode] of (["chip", "roster", "chip", "roster"] as const).entries()) {
    groups.mockClear();
    sidebar.sidebarAgentsMode = mode;
    await settleRoster(sidebar);
    await waitForSolid(expectRows);
    expect(sidebar.querySelector(".sidebar-shell__body")).toBe(body);
    expect(Boolean(sidebar.querySelector("openclaw-sidebar-agent-roster"))).toBe(mode === "roster");
    record(`switch-${index}-${mode}`);
    await update(`ten-${index}-${mode}-updates-with-pins`, mode === "roster" ? 40 : 50);
  }
  expect(initialRoster?.isConnected).toBe(false);
});
