/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import "../lib/toast-host.tsx";
import { loadSettings } from "../app/settings.ts";
import {
  agentIds,
  mountRoster,
  roster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";

async function openAgentMenu(sidebar: HTMLElement, id: string) {
  sidebar
    .querySelector(`[data-agent-id="${id}"]`)!
    .dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
    );
  await vi.waitFor(() => expect(sidebar.querySelector('[data-value="move-down"]')).not.toBeNull());
}

it("keeps the previous order and reports when an edit exceeds the preference limit", async () => {
  document.body.append(document.createElement("openclaw-toast-host"));
  const { sidebar, context } = await mountRoster(roster, []);
  sidebar.sidebarAgentsMode = "roster";
  const saved = Array.from({ length: 61 }, (_, index) => `absent-${index}`.padEnd(64, "x"));
  context.navigation.update({ sidebarAgentOrder: saved });
  await settleRoster(sidebar);
  await openAgentMenu(sidebar, "recent");
  sidebar.querySelector<HTMLElement>('[data-value="move-up"]')!.click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Your previous order is unchanged."),
  );
  expect(context.navigation.snapshot.sidebarAgentOrder).toEqual(saved);
  expect(loadSettings().sidebarAgentOrder).toEqual(saved);
  expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]);
});
function drag(
  target: Element,
  type: string,
  dataTransfer: ReturnType<typeof createDataTransferStub>,
  clientY = -1,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer, clientY });
  target.dispatchEvent(event);
}

it("moves by the native menu, retains focus and local order, and resets from the workspace menu", async () => {
  const { sidebar, context, provider } = await mountRoster(roster, []);
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);
  await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]));
  await openAgentMenu(sidebar, "recent");
  sidebar.querySelector<HTMLElement>('[data-value="move-up"]')!.click();
  await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["recent", "main", "working"]));
  expect(context.navigation.snapshot.sidebarAgentOrder).toEqual(["recent", "main", "working"]);
  expect(loadSettings().sidebarAgentOrder).toEqual(["recent", "main", "working"]);
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-agent-id")).toBe("recent"),
  );
  provider.remove();
  const remounted = await mountRoster(roster, []);
  remounted.sidebar.sidebarAgentsMode = "roster";
  await settleRoster(remounted.sidebar);
  await vi.waitFor(() =>
    expect(agentIds(remounted.sidebar)).toEqual(["recent", "main", "working"]),
  );
  remounted.sidebar.querySelector<HTMLButtonElement>(".sidebar-workspace-header__main")!.click();
  await vi.waitFor(() =>
    expect(
      remounted.sidebar.querySelector('[data-value="command:reset-agent-order"]'),
    ).not.toBeNull(),
  );
  remounted.sidebar.querySelector<HTMLElement>('[data-value="command:reset-agent-order"]')!.click();
  await vi.waitFor(() =>
    expect(agentIds(remounted.sidebar)).toEqual(["main", "recent", "working"]),
  );
  expect(loadSettings().sidebarAgentOrder).toEqual([]);
});

it("uses a separate agent drag kind and never changes pinning, sessions, or group ownership", async () => {
  const { sidebar, context, sessions, request } = await mountRoster(roster, []);
  sidebar.sidebarAgentsMode = "roster";
  context.navigation.update({ sidebarAgentOrder: ["main", "missing", "recent", "working"] });
  await settleRoster(sidebar);
  const header = (id: string) =>
    sidebar.querySelector(`[data-agent-group="${id}"] .sidebar-agent-roster__header`)!;
  const transfer = createDataTransferStub();
  drag(header("working"), "dragstart", transfer);
  await settleRoster(sidebar);
  drag(header("main"), "dragover", transfer);
  drag(header("main"), "drop", transfer);
  await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["working", "main", "recent"]));
  expect(context.navigation.snapshot.sidebarAgentOrder).toEqual([
    "working",
    "main",
    "missing",
    "recent",
  ]);
  expect(transfer.types).toEqual(["application/x-openclaw-sidebar-agent"]);
  for (const mime of [
    "application/x-openclaw-session-key",
    "application/x-openclaw-session-group",
    "text/plain",
  ]) {
    const unrelated = createDataTransferStub();
    unrelated.setData(mime, "agent:main:main");
    drag(header("recent"), "drop", unrelated);
  }
  expect(agentIds(sidebar)).toEqual(["working", "main", "recent"]);
  expect(context.navigation.snapshot.pinnedAgentIds).toEqual([]);
  expect(sessions.sessions.patch).not.toHaveBeenCalled();
  expect(
    request.mock.calls.some(
      ([method]) => method === "sessions.groups.put" || method === "agents.update",
    ),
  ).toBe(false);
});
