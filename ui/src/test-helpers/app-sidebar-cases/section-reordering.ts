import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { createDataTransferStub } from "../drag-data.ts";
import { gatewayHelloForMethods } from "../gateway-methods.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
  clientY = 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer, clientY });
  target.dispatchEvent(event);
}

describe("AppSidebar section reordering", () => {
  async function mountWithGroups(
    groups: string[],
    sectionOrder: string[] = [],
    options: {
      withCatalog?: boolean;
      scopes?: string[];
      groupSessions?: boolean;
    } = {},
  ) {
    const page = catalogPage([{ threadId: "thread-codex", name: "Codex thread" }]);
    const request = vi.fn().mockResolvedValue(page);
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    if (options.withCatalog || options.scopes) {
      const catalogMethods = options.withCatalog ? ["sessions.catalog.list"] : [];
      const hello = gatewayHelloForMethods(
        [...catalogMethods, "sessions.groups.put"],
        options.scopes,
      );
      gateway.publish({ hello });
    }
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:plain",
      "agent:main:thread",
      ...(options.groupSessions ? [] : ["agent:main:builtin-group"]),
      ...groups.map((_, index) => `agent:main:group-${index}`),
    ]);
    const rows = harness.sessions.state.result!.sessions;
    const fixtureRow = (key: string) => rows.find((entry) => entry.key === `agent:main:${key}`)!;
    const codingRow = fixtureRow("thread");
    codingRow.worktree = { id: "worktree-1", branch: "feature", repoRoot: "/repo" };
    if (!options.groupSessions) {
      fixtureRow("builtin-group").kind = "group";
    }
    for (const [index, group] of groups.entries()) {
      Object.assign(fixtureRow(`group-${index}`), {
        category: group,
        ...(options.groupSessions ? { kind: "group" } : {}),
      });
    }
    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    sidebar.connected = true;
    harness.publish({ groups, sectionOrder });
    await sidebar.updateComplete;
    const section = (id: string) => sidebar.querySelector(`[data-session-section="${id}"]`)!;
    const header = (id: string) => section(id).querySelector(".sidebar-recent-sessions__head")!;
    const moveSection = (from: string, to: string) => {
      const transfer = createDataTransferStub();
      dispatchDragEvent(header(from), "dragstart", transfer);
      dispatchDragEvent(section(to), "drop", transfer);
    };
    if (options.withCatalog) {
      await waitForFast(() =>
        expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull(),
      );
    }
    return { sidebar, harness, section, header, moveSection };
  }

  it("allows personal session drags but blocks shared group changes without group write access", async () => {
    const { sidebar, harness, header, section } = await mountWithGroups(["Alpha"], [], {
      scopes: ["operator.read"],
    });
    const source = header("category:Alpha");
    const row = sidebar.querySelector('[data-session-key="agent:main:plain"]')!;

    expect(source.getAttribute("draggable")).toBe("false");
    expect(source.getAttribute("title")).toBeTruthy();
    expect(row.getAttribute("draggable")).toBe("true");
    expect(row.hasAttribute("title")).toBe(false);

    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(section("ungrouped"), "drop", dataTransfer);

    expect(dataTransfer.types).toEqual([]);

    dispatchDragEvent(row, "dragstart", dataTransfer);
    expect(dataTransfer.types).not.toEqual([]);
    dispatchDragEvent(section("category:Alpha"), "dragover", dataTransfer);
    dispatchDragEvent(section("category:Alpha"), "drop", dataTransfer);
    expect(harness.sessions.patch).not.toHaveBeenCalled();
    expect(harness.groupsPut).not.toHaveBeenCalled();
  });

  it("reorders personal pins around a row without changing other navigation entries", async () => {
    const { sidebar, harness, section } = await mountWithGroups(["Alpha"], [], {
      scopes: ["operator.sessions.read"],
    });
    const plain = "session:agent:main:plain";
    const thread = "session:agent:main:thread";
    const group = "session:agent:main:group-0";
    const rail = "session-rail:agent:main:plain";
    const unavailable = "session:agent:missing:saved";
    sidebar.sidebarEntries = [plain, "route:usage", unavailable, thread, rail];
    const update = vi.fn((next: string[]) => {
      sidebar.sidebarEntries = next;
    });
    sidebar.onUpdateSidebarEntries = update;
    await sidebar.updateComplete;
    const row = (entry: string) =>
      section("pinned").querySelector(`[data-session-key="${entry.slice("session:".length)}"]`)!;
    const drop = async (source: Element, target: Element, after = false) => {
      const transfer = createDataTransferStub();
      dispatchDragEvent(source, "dragstart", transfer);
      const bounds = target.getBoundingClientRect();
      dispatchDragEvent(target, "dragover", transfer, after ? bounds.bottom + 1 : bounds.top - 1);
      await sidebar.updateComplete;
      expect(
        target.classList.contains(`sidebar-zone-entry--drop-${after ? "after" : "before"}`),
      ).toBe(true);
      dispatchDragEvent(target, "drop", transfer);
      await sidebar.updateComplete;
    };

    await drop(row(thread), row(plain));
    expect(sidebar.sidebarEntries).toEqual([thread, plain, "route:usage", unavailable, rail]);
    await drop(row(thread), row(plain), true);
    expect(sidebar.sidebarEntries).toEqual([plain, thread, "route:usage", unavailable, rail]);
    const writes = update.mock.calls.length;
    await drop(row(plain), row(plain));
    expect(update).toHaveBeenCalledTimes(writes);
    await drop(sidebar.querySelector('[data-session-key="agent:main:group-0"]')!, row(thread));
    expect(sidebar.sidebarEntries).toEqual([
      plain,
      group,
      thread,
      "route:usage",
      unavailable,
      rail,
    ]);
    expect(harness.sessions.patch).not.toHaveBeenCalled();
    expect(harness.groupsPut).not.toHaveBeenCalled();
  });

  it("drags a section from its label toggle without a dedicated grip", async () => {
    const { sidebar, header, harness } = await mountWithGroups(["Alpha", "Beta"]);
    const source = header("category:Beta");
    const toggle = source.querySelector(".sidebar-session-group-toggle")!;
    const dataTransfer = createDataTransferStub();

    expect(
      source.querySelector(".sidebar-session-group-drag-handle, .sidebar-reorder-trigger"),
    ).toBeNull();
    toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    dispatchDragEvent(source, "dragstart", dataTransfer);

    expect(dataTransfer.types).not.toEqual([]);
    expect(sidebar.sessionOrganizer.draggingSidebarSection).toBe("category:Beta");
    dispatchDragEvent(header("category:Alpha"), "drop", dataTransfer);
    await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalled());
  });

  it("keeps new-session link gestures separate from section dragging and menus", async () => {
    const { sidebar, header } = await mountWithGroups(["Alpha"]);
    const dataTransfer = createDataTransferStub();
    const newSessionButton = header("category:Alpha").querySelector(".sidebar-new-session");

    expect(newSessionButton!.getAttribute("href")).toBe("/new?agent=main&group=Alpha");
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    newSessionButton!.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-group-menu")).toBeNull();

    newSessionButton!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    dispatchDragEvent(header("category:Alpha"), "dragstart", dataTransfer);

    expect(dataTransfer.types).toEqual([]);
    expect(sidebar.sessionOrganizer.draggingSidebarSection).toBeNull();
  });

  it("clears a group session category when it drops onto Groups", async () => {
    const { sidebar, harness, section } = await mountWithGroups(["Done"], [], {
      groupSessions: true,
    });
    await activateSessionMenuValue(sidebar, "empty-groups:never");
    const source = sidebar.querySelector('[data-session-key="agent:main:group-0"]');
    const groupsSection = section("groups");
    expect(source).not.toBeNull();
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(source!, "dragstart", dataTransfer);
    dispatchDragEvent(groupsSection, "dragover", dataTransfer);
    expect(dataTransfer.dropEffect).toBe("move");
    dispatchDragEvent(groupsSection, "drop", dataTransfer);

    await waitForFast(() =>
      expect(harness.patch).toHaveBeenCalledWith(
        "agent:main:group-0",
        { category: null },
        { agentId: "main", expectedSessionId: "session:agent:main:group-0" },
      ),
    );
  });

  it.each([false, true])(
    "persists section moves without losing catalog slots (loaded: %s)",
    async (withCatalog) => {
      const order = ["ungrouped", "groups", "work", "catalog:codex"];
      const { harness, moveSection } = await mountWithGroups([], withCatalog ? [] : order, {
        withCatalog,
      });
      moveSection(withCatalog ? "catalog:codex" : "work", withCatalog ? "work" : "ungrouped");
      await waitForFast(() =>
        expect(harness.groupsPut).toHaveBeenCalledWith(
          [],
          withCatalog
            ? ["ungrouped", "groups", "catalog:codex", "work"]
            : ["work", "ungrouped", "groups", "catalog:codex"],
        ),
      );
    },
  );
});
