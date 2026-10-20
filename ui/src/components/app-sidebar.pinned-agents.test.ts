/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { loadSettings } from "../app/settings.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  agentIds,
  mountRoster,
  roster,
  session,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";

const reply = () => [
  session("main", 30, {
    lastMessagePreview: "A newer user question",
    lastAssistantMessage: { text: "The assistant's latest answer", timestamp: 20 },
  }),
];
const pinned = (sidebar: Element) => sidebar.querySelector('[data-pinned-agent="main"]');
const menuItem = (sidebar: Element, value: string) =>
  sidebar.querySelector<HTMLElement>(`[data-value="${value}"]`)!;
async function openMenu(sidebar: Element, value = "sessions") {
  sidebar.querySelector<HTMLButtonElement>('button[aria-label="Options for Harbor"]')!.click();
  await vi.waitFor(() => expect(menuItem(sidebar, value)).not.toBeNull());
  return menuItem(sidebar, value);
}
const modalButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
    (button) => button.textContent === text,
  )!;

it("pins an agent into a menu-less gallery above the roster and preserves the other agents", async () => {
  const { sidebar, context, provider } = await mountRoster(roster, reply());
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
  const remounted = await mountRoster(roster, reply());
  remounted.sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(pinned(remounted.sidebar)).not.toBeNull());
  await settleRoster(remounted.sidebar);
  const pin = pinned(remounted.sidebar)!;
  const content = pin.querySelector('[slot="content"]')?.textContent;
  expect(content).toContain("The assistant's latest answer");
  expect(content).not.toContain("A newer user question");
  expect(pin.querySelector(".sidebar-agent-roster__preview")).toBeNull();
  const link = pin.querySelector<HTMLAnchorElement>("a")!;
  link.focus();
  const tooltip = pin.querySelector("openclaw-tooltip")!;
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(true));
  expect(link.getAttribute("aria-describedby")).toBeTruthy();
  link.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(false));
  expect(document.activeElement).toBe(link);
  expect(pin.querySelector("button")).toBeNull();
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

it.each(["main", "recent"])(
  "renders no provisional session row for a %s-agent create in the agent roster",
  async (agentId) => {
    const { sidebar, context } = await mountRoster(roster, []);
    context.navigation.update({ pinnedAgentIds: ["main"] });
    sidebar.sidebarAgentsMode = "roster";
    sidebar.activeRouteId = "chat";
    const sessionKey = `agent:${agentId}:creating`;
    sidebar.sessionKey = sessionKey;
    await vi.waitFor(() => expect(pinned(sidebar)).not.toBeNull());
    const release = context.chatSubmissions.beginCreate({
      creation: { sessionKey, admitted: false },
      displayName: "Preparing new conversation",
      message: null,
      canDisplay: () => true,
    });
    try {
      await settleRoster(sidebar);
      expect(sidebar.getRouteSessionKey()).toBe(sessionKey);
      expect(sidebar.querySelector(".sidebar-recent-session--creating")).toBeNull();
      expect(sidebar.textContent).not.toContain("Preparing new conversation");
      expect(agentIds(sidebar)).toEqual(["recent", "working"]);
    } finally {
      release();
    }
  },
);

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
