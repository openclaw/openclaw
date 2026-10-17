import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { createDataTransferStub } from "../drag-data.ts";
import { gatewayHelloForMethods } from "../gateway-methods.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

describe("AppSidebar section reordering", () => {
  async function mountWithGroups(
    groups: string[],
    sectionOrder: string[] = [],
    options: {
      withCatalog?: boolean;
      withBuiltinGroup?: boolean;
      scopes?: string[];
      groupSessionCategories?: readonly string[];
    } = {},
  ) {
    const request = vi
      .fn()
      .mockResolvedValue(catalogPage([{ threadId: "thread-codex", name: "Codex thread" }]));
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    if (options.withCatalog || options.scopes) {
      gateway.publish({
        hello: gatewayHelloForMethods(
          [...(options.withCatalog ? ["sessions.catalog.list"] : []), "sessions.groups.put"],
          options.scopes,
        ),
      });
    }
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:plain",
      "agent:main:thread",
      ...(options.withBuiltinGroup === false ? [] : ["agent:main:builtin-group"]),
      ...groups.map((_, index) => `agent:main:group-${index}`),
    ]);
    const rows = harness.sessions.state.result!.sessions;
    const fixtureRow = (key: string) => rows.find((entry) => entry.key === `agent:main:${key}`)!;
    const codingRow = fixtureRow("thread");
    codingRow.worktree = { id: "worktree-1", branch: "feature", repoRoot: "/repo" };
    if (options.withBuiltinGroup !== false) {
      fixtureRow("builtin-group").kind = "group";
    }
    for (const [index, group] of groups.entries()) {
      const row = fixtureRow(`group-${index}`);
      row.category = group;
      if (options.groupSessionCategories?.includes(group)) {
        row.kind = "group";
      }
    }
    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    sidebar.connected = true;
    harness.publish({ groups, sectionOrder });
    await sidebar.updateComplete;
    if (options.withCatalog) {
      await waitForFast(() =>
        expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull(),
      );
    }
    return { sidebar, harness };
  }

  function section(sidebar: SidebarLifecycleState, id: string) {
    const element = sidebar.querySelector(`[data-session-section="${id}"]`);
    if (!element) {
      throw new Error(`expected section ${id}`);
    }
    return element;
  }

  function groupHeader(sidebar: SidebarLifecycleState, id: string) {
    return section(sidebar, id).querySelector(".sidebar-recent-sessions__head")!;
  }

  function moveSection(sidebar: SidebarLifecycleState, from: string, to: string) {
    const transfer = createDataTransferStub();
    dispatchDragEvent(groupHeader(sidebar, from), "dragstart", transfer);
    dispatchDragEvent(section(sidebar, to), "drop", transfer);
  }

  it("disables section and row dragging without group write access", async () => {
    const { sidebar, harness } = await mountWithGroups(["Alpha"], [], {
      scopes: ["operator.read"],
    });
    const header = groupHeader(sidebar, "category:Alpha");
    const row = sidebar.querySelector('[data-session-key="agent:main:plain"]');

    expect(header.getAttribute("draggable")).toBe("false");
    expect(header.getAttribute("title")).toBeTruthy();
    expect(row?.getAttribute("draggable")).toBe("false");
    expect(row?.hasAttribute("title")).toBe(false);

    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(header, "dragstart", dataTransfer);
    dispatchDragEvent(section(sidebar, "ungrouped"), "drop", dataTransfer);

    expect(dataTransfer.types).toEqual([]);
    expect(harness.groupsPut).not.toHaveBeenCalled();
  });

  it("keeps new-session link gestures separate from section dragging and menus", async () => {
    const { sidebar } = await mountWithGroups(["Alpha"]);
    const dataTransfer = createDataTransferStub();
    const newSessionButton = groupHeader(sidebar, "category:Alpha").querySelector(
      ".sidebar-new-session",
    );
    if (!newSessionButton) {
      throw new Error("expected new-session header action");
    }

    expect(newSessionButton.getAttribute("href")).toBe("/new?agent=main&group=Alpha");
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    newSessionButton.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-group-menu")).toBeNull();

    newSessionButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    dispatchDragEvent(groupHeader(sidebar, "category:Alpha"), "dragstart", dataTransfer);

    expect(dataTransfer.types).toEqual([]);
    expect(sidebar.sessionOrganizer.draggingSidebarSection).toBeNull();
  });

  it("clears a group session category when it drops onto Groups", async () => {
    const { sidebar, harness } = await mountWithGroups(["Done"], [], {
      withBuiltinGroup: false,
      groupSessionCategories: ["Done"],
    });
    const source = sidebar.querySelector('[data-session-key="agent:main:group-0"]');
    const groupsSection = section(sidebar, "groups");
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

  it("preserves saved catalog slots while the first catalog load is pending", async () => {
    const { sidebar, harness } = await mountWithGroups(
      [],
      ["ungrouped", "groups", "work", "catalog:codex"],
    );
    moveSection(sidebar, "work", "ungrouped");

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        [],
        ["work", "ungrouped", "groups", "catalog:codex"],
      ),
    );
  });

  it("persists a catalog section move relative to Coding", async () => {
    const { sidebar, harness } = await mountWithGroups([], [], { withCatalog: true });
    moveSection(sidebar, "catalog:codex", "work");

    await waitForFast(() =>
      expect(harness.groupsPut).toHaveBeenCalledWith(
        [],
        ["ungrouped", "groups", "catalog:codex", "work"],
      ),
    );
  });
});
