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
