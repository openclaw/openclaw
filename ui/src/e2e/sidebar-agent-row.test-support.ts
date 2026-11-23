import type { Locator } from "playwright";

const selectedRow = ".sidebar-agent-roster--selected .sidebar-agent-roster__header";

/** Opens an agent row's menu and chooses one of its items. */
async function chooseFromAgentRow(header: Locator, value: string) {
  await header.hover();
  await header.locator(".sidebar-agent-roster__action").click();
  await header.locator('[role="menu"] [data-value="' + value + '"]').click();
}

/** Opens the selected agent row's menu and returns the row that holds it. */
export async function openSelectedAgentRowMenu(sidebar: Locator): Promise<Locator> {
  const header = sidebar.locator(selectedRow);
  await header.hover();
  await header.locator(".sidebar-agent-roster__action").click();
  await header.locator('[role="menu"] [data-value]').first().waitFor();
  return header;
}

/** The one-agent list: its row leads the sidebar and carries Show all agents. */
export function selectedAgentRow(sidebar: Locator): Locator {
  return sidebar.locator(selectedRow);
}

export async function showAllSidebarAgents(sidebar: Locator): Promise<void> {
  await chooseFromAgentRow(selectedAgentRow(sidebar), "show-all");
  await sidebar.locator("openclaw-sidebar-agent-roster [data-agent-group]").first().waitFor();
}

/** Switches to one agent, by id or name: Show all agents, then that agent's Show only this agent. */
export async function showOnlySidebarAgent(sidebar: Locator, agent: string): Promise<void> {
  // Either list mode can still be mounting; act once one of them is on screen.
  await sidebar
    .locator(selectedRow + ", openclaw-sidebar-agent-roster [data-agent-group]")
    .first()
    .waitFor();
  if (await selectedAgentRow(sidebar).count()) {
    await showAllSidebarAgents(sidebar);
  }
  const group = sidebar
    .locator('[data-agent-group="' + agent + '"], [data-agent-group][aria-label="' + agent + '"]')
    .first();
  const agentId = await group.getAttribute("data-agent-group");
  await chooseFromAgentRow(group.locator(".sidebar-agent-roster__header"), "show-only");
  await sidebar
    .locator(selectedRow + ' .sidebar-agent-roster__row[data-agent-id="' + agentId + '"]')
    .waitFor();
}
