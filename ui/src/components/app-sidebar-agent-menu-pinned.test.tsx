/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { mountSolid as render } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { renderSidebarAgentMenu as AgentMenu } from "./app-sidebar-agent-menu.tsx";

const agents = [
  { id: "main", name: "Harbor" },
  { id: "scout", name: "Scout" },
  { id: "forge", name: "Forge" },
  { id: "probe", name: "Probe" },
];

function renderMenu(props: Partial<Parameters<typeof AgentMenu>[0]> = {}) {
  return render(() => (
    <AgentMenu
      activeId="main"
      agents={agents}
      identities={new Map()}
      openMode="click"
      position={{ x: 12, top: 30 }}
      basePath=""
      rosterMode={false}
      creationDisabledReason={null}
      resolveAvatarUrl={(url) => url}
      avatarErrorHandler={() => vi.fn()}
      agentUnreadCount={() => 0}
      onShowAllAgents={vi.fn()}
      onCreateAgent={vi.fn()}
      onPointerEnter={vi.fn()}
      onPointerLeave={vi.fn()}
      onAfterShow={vi.fn()}
      onSwitchAgent={vi.fn()}
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      {...props}
    />
  ));
}

const rowValues = (menu: Element) =>
  [...menu.querySelectorAll('[data-value^="agent:"]')].map((row) =>
    decodeURIComponent(row.getAttribute("data-value")!.slice("agent:".length)),
  );

it("lists pinned agents first in pin order and marks their rows", () => {
  const view = renderMenu({ pinnedAgentIds: ["forge", "probe"] });
  flush();
  const menu = view.getByRole("menu", { hidden: true });
  expect(rowValues(menu)).toEqual(["forge", "probe", "main", "scout"]);

  const forge = menu.querySelector('[data-value="agent:forge"]')!;
  expect(forge.classList.contains("sidebar-agent-menu__agent-switch--pinned")).toBe(true);
  expect(forge.querySelector(".sidebar-agent-menu__pinned-badge")).not.toBeNull();
  expect(
    menu.querySelector('[data-value="agent:main"] .sidebar-agent-menu__pinned-badge'),
  ).toBeNull();
  expect(
    menu.querySelector('[data-value="agent:scout"] .sidebar-agent-menu__pinned-badge'),
  ).toBeNull();
});

it("leaves roster order alone without pins", () => {
  const view = renderMenu();
  flush();
  const menu = view.getByRole("menu", { hidden: true });
  expect(rowValues(menu)).toEqual(["main", "scout", "forge", "probe"]);
  expect(menu.querySelector('[data-value="scope:all"]')).not.toBeNull();
});

it("keeps the agent being created ahead of the pins", () => {
  const view = renderMenu({
    pinnedAgentIds: ["probe"],
    pendingAgent: { id: "fresh", name: "Fresh" },
  });
  flush();
  const menu = view.getByRole("menu", { hidden: true });
  expect(rowValues(menu)).toEqual(["fresh", "probe", "main", "scout", "forge"]);
});

it("keeps the recently created agent ahead of the pins", () => {
  const view = renderMenu({ pinnedAgentIds: ["probe"], recentlyCreatedAgentId: "scout" });
  flush();
  const menu = view.getByRole("menu", { hidden: true });
  expect(rowValues(menu)).toEqual(["scout", "probe", "main", "forge"]);
});
