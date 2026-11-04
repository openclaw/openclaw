/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { loadSettings } from "../app/settings.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  agentIds,
  mountRoster,
  roster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";

const pinned = (sidebar: Element) => sidebar.querySelector('[data-pinned-agent="main"]');
const menuItem = (sidebar: Element, value: string) =>
  sidebar.querySelector<HTMLElement>(`[data-value="${value}"]`)!;
async function openMenu(sidebar: Element, value = "sessions") {
  sidebar.querySelector<HTMLButtonElement>('button[aria-label="Options for Harbor"]')!.click();
  await vi.waitFor(() => expect(menuItem(sidebar, value)).not.toBeNull());
  return menuItem(sidebar, value);
}
const rightClick = (element: Element) =>
  element.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
  );
const modalButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
    (button) => button.textContent === text,
  )!;

it("persists pins across remounts without removing the other agents", async () => {
  const { sidebar, context, provider } = await mountRoster(roster, []);
  sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
  await settleRoster(sidebar);
  (await openMenu(sidebar, "pin")).click();
  await vi.waitFor(() => {
    expect(pinned(sidebar)).not.toBeNull();
    expect(agentIds(sidebar)).toEqual(["recent", "working"]);
  });
  expect(context.navigation.snapshot.pinnedAgentIds).toEqual(["main"]);
  expect(loadSettings().pinnedAgentIds).toEqual(["main"]);
  expect(document.activeElement?.getAttribute("data-agent-id")).toBe("main");
  provider.remove();
  const remounted = await mountRoster(roster, []);
  remounted.sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(pinned(remounted.sidebar)).not.toBeNull());
  await settleRoster(remounted.sidebar);
  remounted.context.navigation.update({ pinnedAgentIds: [] });
  await vi.waitFor(() => {
    expect(remounted.sidebar.querySelector("[data-pinned-agent]")).toBeNull();
    expect(agentIds(remounted.sidebar)).toEqual(["main", "recent", "working"]);
  });
});

it("keeps every configured pin available and ignores unavailable saved agents", async () => {
  const agents = {
    ...roster,
    agents: [
      ...roster.agents,
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `helper-${index}`,
        name: `Research and release coordination assistant ${index}`,
      })),
    ],
  };
  const { sidebar, context } = await mountRoster(agents, []);
  context.navigation.update({
    pinnedAgentIds: ["missing", ...agents.agents.map((agent) => agent.id)],
  });
  sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(sidebar.querySelectorAll("[data-pinned-agent]")).toHaveLength(23));
  expect(agentIds(sidebar)).toEqual([]);
  expect(
    [...sidebar.querySelectorAll("[data-pinned-agent]")].map((node) =>
      node.getAttribute("data-pinned-agent"),
    ),
  ).toEqual(agents.agents.filter((agent) => agent.id !== "system").map((agent) => agent.id));
  expect(
    sidebar.querySelector('[data-pinned-agent="main"] [slot="content"]')?.textContent,
  ).toContain("No assistant reply yet");
  expect(context.navigation.snapshot.pinnedAgentIds).toContain("missing");
});

it("offers agent sessions and settings without a create action, and confirms agent deletion", async () => {
  const { sidebar, context, gatewayHarness, request } = await mountRoster(roster, []);
  const onNavigate = vi.fn();
  const navigate = vi.spyOn(context, "navigate");
  sidebar.onNavigate = onNavigate;
  context.agents.refreshList = vi.fn(async () => context.agents.state.agentsList);
  gatewayHarness.publish({
    hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "agents.delete"]),
  });
  sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
  await settleRoster(sidebar);

  await openMenu(sidebar);
  expect(menuItem(sidebar, "new-session")).toBeNull();
  expect(menuItem(sidebar, "sessions").textContent).toContain("Sessions");
  expect(menuItem(sidebar, "settings").textContent).toContain("Settings");
  expect(menuItem(sidebar, "delete").textContent).toContain("Delete");
  menuItem(sidebar, "sessions").click();
  expect(context.agentSelection.state.selectedId).toBe("main");
  expect(onNavigate).toHaveBeenCalledWith("sessions");

  (await openMenu(sidebar, "settings")).click();
  expect(navigate).toHaveBeenCalledWith("agents", {
    pathname: "/settings/agents/main",
  });

  (await openMenu(sidebar, "delete")).click();
  await vi.waitFor(() =>
    expect(document.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Delete Harbor?",
    ),
  );
  modalButton("Cancel").click();
  expect(request).not.toHaveBeenCalledWith("agents.delete", expect.anything());

  const previousRequest = request.getMockImplementation()!;
  request.mockImplementation((...args) =>
    args[0] === "agents.delete"
      ? Promise.resolve({ ok: true, agentId: "main", removedBindings: 0 })
      : previousRequest(...args),
  );
  (await openMenu(sidebar, "delete")).click();
  await vi.waitFor(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
  modalButton("Delete").click();
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith("agents.delete", {
      agentId: "main",
      deleteFiles: true,
    });
    expect(context.agents.refreshList).toHaveBeenCalledOnce();
  });
});

it("offers Create Template from the pinned agent menu", async () => {
  const { sidebar, context, gatewayHarness, request } = await mountRoster(roster, []);
  context.runtimeConfig.state.configForm = {
    gateway: { controlUi: { experimental: { templates: true } } },
  };
  context.navigation.update({ pinnedAgentIds: ["main"] });
  gatewayHarness.publish({
    hello: gatewayHelloForMethods([
      ...SESSION_MUTATION_TEST_METHODS,
      "templates.drafts.create",
      "chat.send",
    ]),
  });
  sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(pinned(sidebar)).not.toBeNull());
  await settleRoster(sidebar);

  const previousRequest = request.getMockImplementation()!;
  request.mockImplementation((...args) =>
    args[0] === "templates.drafts.create"
      ? Promise.reject(new Error("The agent workspace is unavailable."))
      : previousRequest(...args),
  );
  expect(pinned(sidebar)!.querySelector("button")).toBeNull();
  rightClick(pinned(sidebar)!);
  await vi.waitFor(() => expect(menuItem(sidebar, "create-template")).not.toBeNull());
  menuItem(sidebar, "create-template").click();
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("templates.drafts.create", { agentId: "main" }),
  );
  expect(context.navigation.snapshot.pinnedAgentIds).toEqual(["main"]);
});
