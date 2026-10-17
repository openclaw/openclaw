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

it("pins an agent above the roster, preserves the other agents, and unpins through its menu", async () => {
  const { sidebar, context, provider } = await mountRoster(roster, [
    session("main", 30, {
      lastMessagePreview: "A newer user question",
      lastAssistantMessage: { text: "The assistant's latest answer", timestamp: 20 },
    }),
  ]);
  sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
  await settleRoster(sidebar);
  sidebar.querySelector<HTMLButtonElement>('button[aria-label="Options for Harbor"]')!.click();
  await vi.waitFor(() => expect(sidebar.querySelector('[data-value="pin"]')).not.toBeNull());
  sidebar.querySelector<HTMLElement>('[data-value="pin"]')!.click();
  await vi.waitFor(() => {
    expect(sidebar.querySelector('[data-pinned-agent="main"]')).not.toBeNull();
    expect(agentIds(sidebar)).toEqual(["recent", "working"]);
  });
  expect(context.navigation.snapshot.pinnedAgentIds).toEqual(["main"]);
  expect(loadSettings().pinnedAgentIds).toEqual(["main"]);
  expect(document.activeElement?.getAttribute("data-agent-id")).toBe("main");
  provider.remove();
  const remounted = await mountRoster(roster, [
    session("main", 30, {
      lastMessagePreview: "A newer user question",
      lastAssistantMessage: { text: "The assistant's latest answer", timestamp: 20 },
    }),
  ]);
  remounted.sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() =>
    expect(remounted.sidebar.querySelector('[data-pinned-agent="main"]')).not.toBeNull(),
  );
  await settleRoster(remounted.sidebar);
  const pin = remounted.sidebar.querySelector('[data-pinned-agent="main"]')!;
  expect(pin.querySelector('[slot="content"]')?.textContent).toContain(
    "The assistant's latest answer",
  );
  expect(pin.querySelector('[slot="content"]')?.textContent).not.toContain("A newer user question");
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
  const options = pin.querySelector<HTMLButtonElement>('button[aria-label="Options for Harbor"]')!;
  options.focus();
  options.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await vi.waitFor(() =>
    expect(remounted.sidebar.querySelector('[data-value="pin"]')?.textContent).toContain("Unpin"),
  );
  remounted.sidebar.querySelector<HTMLElement>('[data-value="pin"]')!.click();
  await vi.waitFor(() => {
    expect(remounted.sidebar.querySelector("[data-pinned-agent]")).toBeNull();
    expect(agentIds(remounted.sidebar)).toEqual(["main", "recent", "working"]);
    expect(loadSettings().pinnedAgentIds).toEqual([]);
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

it("keeps provisional session feedback visible below the pinned agent gallery", async () => {
  const { sidebar, context } = await mountRoster(roster, []);
  context.navigation.update({ pinnedAgentIds: ["main"] });
  sidebar.sidebarAgentsMode = "roster";
  sidebar.activeRouteId = "chat";
  sidebar.sessionKey = "agent:main:creating";
  await vi.waitFor(() =>
    expect(sidebar.querySelector('[data-pinned-agent="main"]')).not.toBeNull(),
  );
  const release = context.chatSubmissions.beginCreate({
    creation: { sessionKey: "agent:main:creating", admitted: false },
    displayName: "Preparing new conversation",
    message: null,
    canDisplay: () => true,
  });
  try {
    await settleRoster(sidebar);
    const pending = sidebar.querySelector(
      ".sidebar-agent-roster > .sidebar-recent-session--creating",
    );
    expect(pending?.textContent).toContain("Preparing new conversation");
    expect(sidebar.querySelectorAll(".sidebar-recent-session--creating")).toHaveLength(1);
  } finally {
    release();
  }
  await settleRoster(sidebar);
  expect(sidebar.querySelector(".sidebar-recent-session--creating")).toBeNull();
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

  const openMenu = async () => {
    sidebar.querySelector<HTMLButtonElement>('button[aria-label="Options for Harbor"]')!.click();
    await vi.waitFor(() => expect(sidebar.querySelector('[data-value="sessions"]')).not.toBeNull());
  };
  await openMenu();
  expect(sidebar.querySelector('[data-value="new-session"]')).toBeNull();
  expect(sidebar.querySelector('[data-value="sessions"]')?.textContent).toContain("Sessions");
  expect(sidebar.querySelector('[data-value="settings"]')?.textContent).toContain("Settings");
  expect(sidebar.querySelector('[data-value="delete"]')?.textContent).toContain("Delete");
  sidebar.querySelector<HTMLElement>('[data-value="sessions"]')!.click();
  expect(context.agentSelection.state.selectedId).toBe("main");
  expect(onNavigate).toHaveBeenCalledWith("sessions");

  await openMenu();
  sidebar.querySelector<HTMLElement>('[data-value="settings"]')!.click();
  expect(navigate).toHaveBeenCalledWith("agents", {
    pathname: "/settings/agents/main",
  });

  await openMenu();
  sidebar.querySelector<HTMLElement>('[data-value="delete"]')!.click();
  await vi.waitFor(() =>
    expect(document.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Delete Harbor?",
    ),
  );
  const modal = document.querySelector("openclaw-modal-dialog")!;
  const cancel = [...modal.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  )!;
  cancel.click();
  expect(request).not.toHaveBeenCalledWith("agents.delete", expect.anything());

  const previousRequest = request.getMockImplementation()!;
  request.mockImplementation((...args) =>
    args[0] === "agents.delete"
      ? Promise.resolve({ ok: true, agentId: "main", removedBindings: 0 })
      : previousRequest(...args),
  );
  await openMenu();
  sidebar.querySelector<HTMLElement>('[data-value="delete"]')!.click();
  await vi.waitFor(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
  const confirm = [
    ...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
  ].find((button) => button.textContent === "Delete")!;
  confirm.click();
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith("agents.delete", {
      agentId: "main",
      deleteFiles: true,
    });
    expect(context.agents.refreshList).toHaveBeenCalledOnce();
  });
});
