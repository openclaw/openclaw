import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import { agentIds, mountRoster } from "./roster.test-support.ts";

function selectAgentAction(sidebar: HTMLElement, id: string, value: string) {
  const group = sidebar.querySelector(`[data-agent-group="${id}"]`)!;
  const item = group.querySelector(`wa-dropdown-item[value="${value}"]`)!;
  item
    .closest("wa-dropdown")!
    .dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));
}

describe("AppSidebar manual agent order", () => {
  it("moves a complete agent section, persists preference, keeps focus and resets", async () => {
    const { sidebar, context, request } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await sidebar.updateComplete;
    await vi.waitFor(() => expect(agentIds(sidebar).length).toBeGreaterThan(1));
    const initial = agentIds(sidebar);
    const id = initial[1]!;
    selectAgentAction(sidebar, id, "move-up");
    await vi.waitFor(() => expect(agentIds(sidebar)[0]).toBe(id));
    expect(loadSettings(context.gateway.connection.gatewayUrl).sidebarAgentOrder?.[0]).toBe(id);
    expect(sidebar.querySelector(`[data-agent-group="${id}"] [slot="trigger"]`)).toBe(
      document.activeElement,
    );
    expect(sidebar.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain(
      "position 1",
    );
    expect(request.mock.calls.some(([method]) => method === "sessions.groups.put")).toBe(false);
    selectAgentAction(sidebar, id, "reset-order");
    await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(initial));
    expect(loadSettings(context.gateway.connection.gatewayUrl).sidebarAgentOrder).toEqual([]);
  });

  it("accepts remote preference updates without losing missing agent IDs on a move", async () => {
    const { sidebar, context } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await sidebar.updateComplete;
    await vi.waitFor(() => expect(agentIds(sidebar).length).toBeGreaterThan(1));
    const initial = agentIds(sidebar);
    context.navigation.update({ sidebarAgentOrder: ["temporarily-missing", initial[1]!] });
    await vi.waitFor(() => expect(agentIds(sidebar)[0]).toBe(initial[1]));
    selectAgentAction(sidebar, initial[0]!, "move-up");
    await vi.waitFor(() => expect(agentIds(sidebar)[0]).toBe(initial[0]));
    expect(context.navigation.snapshot.sidebarAgentOrder).toContain("temporarily-missing");
  });

  it("uses a dedicated drag payload and ignores session/section/route payloads", async () => {
    const { sidebar, context } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await sidebar.updateComplete;
    await vi.waitFor(() => expect(agentIds(sidebar).length).toBeGreaterThan(1));
    const initial = agentIds(sidebar);
    const source = sidebar.querySelector(
      `[data-agent-group="${initial[1]}"] .sidebar-recent-sessions__head`,
    )!;
    const target = sidebar.querySelector(`[data-agent-group="${initial[0]}"]`)!;
    const data = new Map<string, string>();
    const transfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      get types() {
        return [...data.keys()];
      },
      effectAllowed: "",
      dropEffect: "",
    };
    const drag = (element: Element, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: -1 } });
      element.dispatchEvent(event);
    };
    drag(source, "dragstart");
    expect([...data.keys()]).toEqual(["application/x-openclaw-sidebar-agent"]);
    drag(target, "dragover");
    drag(target, "drop");
    await vi.waitFor(() => expect(agentIds(sidebar)[0]).toBe(initial[1]));
    const saved = context.navigation.snapshot.sidebarAgentOrder;
    for (const type of [
      "application/x-openclaw-session",
      "application/x-openclaw-sidebar-section",
      "application/x-openclaw-sidebar-route",
    ]) {
      data.clear();
      data.set(type, initial[0]!);
      drag(target, "dragover");
      drag(target, "drop");
      expect(context.navigation.snapshot.sidebarAgentOrder).toEqual(saved);
    }
  });
});
