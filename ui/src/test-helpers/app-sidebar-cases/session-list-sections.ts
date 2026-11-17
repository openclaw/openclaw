import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import {
  createGateway,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { sessionListResult } from "../chat-model.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.tsx";

describe("AppSidebar session section visibility", () => {
  it("pages every section, the last one included, when several render", async () => {
    const threadKeys = Array.from({ length: 17 }, (_, index) => `agent:main:thread-${index}`);
    const categoryKeys = Array.from({ length: 17 }, (_, index) => `agent:main:alpha-${index}`);
    const sessions = createSessionsHarness("main", [...threadKeys, ...categoryKeys]);
    const result = sessions.result;
    for (const row of result.sessions) {
      if (categoryKeys.includes(row.key)) {
        row.category = "Alpha";
      }
    }
    sessions.publish({ groups: ["Alpha"] });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    const category = sidebar.querySelector('[data-session-section="category:Alpha"]');
    const threads = sidebar.querySelector('[data-session-section="ungrouped"]');
    // Show more renders once its lazy module loads.
    const expectSection = (section: Element | null, rows: number, paged: boolean) =>
      vi.waitFor(() => {
        expect(section?.querySelectorAll(".sidebar-recent-session")).toHaveLength(rows);
        expect(section?.querySelector('[aria-label="Show more"]') !== null).toBe(paged);
      });

    expect(threads?.querySelector(".sidebar-recent-sessions__label-text")?.textContent).toBe(
      "Other",
    );
    await expectSection(category, 15, true);
    await expectSection(threads, 15, true);

    threads?.querySelector<HTMLButtonElement>('[aria-label="Show more"]')?.click();
    await settleLitElement(sidebar);

    await expectSection(category, 15, true);
    await expectSection(threads, 17, false);
  });

  it("keeps the rows a lone Other showed when a group arrives below it", async () => {
    const keys = Array.from({ length: 40 }, (_, index) => `agent:main:thread-${index}`);
    const harness = createSessionsHarness("main", keys);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    const rows = () =>
      sidebar.querySelectorAll('[data-session-section="ungrouped"] .sidebar-recent-session');
    expect(rows()).toHaveLength(40);

    const result = harness.sessions.state.result!;
    harness.publishList({
      result: {
        ...result,
        sessions: [...result.sessions, { key: "agent:main:room", kind: "group", updatedAt: 0 }],
      },
    });
    await settleLitElement(sidebar);

    expect(sidebar.querySelector('[data-session-section="groups"]')).not.toBeNull();
    expect(rows()).toHaveLength(40);
    const collapse = () =>
      sidebar.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]');
    await vi.waitFor(() => expect(collapse()).not.toBeNull());
    collapse()!.click();
    await settleLitElement(sidebar);
    expect(rows()).toHaveLength(15);
    await vi.waitFor(() =>
      expect(sidebar.querySelector('button[aria-label="Show more"]')).not.toBeNull(),
    );
  });

  it("counts a rendered empty Other heading as a second section", async () => {
    const keys = Array.from({ length: 20 }, (_, index) => `agent:main:alpha-${index}`);
    const sessions = createSessionsHarness("main", keys);
    for (const row of sessions.result.sessions) {
      row.category = "Alpha";
    }
    sessions.publish({ groups: ["Alpha"] });
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessions.sessions,
    );
    await activateSessionMenuValue(sidebar, "empty-groups:never");
    await activateSessionMenuValue(sidebar, "status:all");
    await settleLitElement(sidebar);
    const alpha = sidebar.querySelector('[data-session-section="category:Alpha"]');

    expect(sidebar.querySelector('[data-session-section="ungrouped"]')).not.toBeNull();
    expect(alpha?.querySelectorAll(".sidebar-recent-session")).toHaveLength(15);
    await vi.waitFor(() => expect(alpha?.querySelector('[aria-label="Show more"]')).not.toBeNull());
  });

  it("keeps global session actions when every unpinned thread has a custom group", async () => {
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:research",
      "agent:main:operations",
    ]);
    const result = harness.result;
    for (const row of result.sessions) {
      if (row.key === "agent:main:research") {
        row.category = "Research";
      }
      if (row.key === "agent:main:operations") {
        row.category = "Operations";
      }
    }
    harness.publish({ groups: ["Research", "Operations"] });

    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    const threads = sidebar.querySelector('[data-session-section="ungrouped"]');

    expect(sidebar.querySelector('[data-session-section="category:Research"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).not.toBeNull();
    expect(threads).toBeNull();

    const toolbar = sidebar.querySelector(".sidebar-session-toolbar");
    expect(toolbar?.querySelector(".sidebar-panel-header__title")?.textContent).toBe("Sessions");
    const filter = toolbar?.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    expect(filter).not.toBeNull();
    expect(filter?.getAttribute("aria-label")).toBe("Filter & sort · Active");
    expect(sidebar.querySelector('.sidebar-rail [aria-label="New session"]')).not.toBeNull();
    filter?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).not.toBeNull();
  });

  it("renders a lone ungrouped list without a header despite stale collapsed state", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:other"]),
    );

    sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set(["ungrouped"]));
    await sidebar.updateComplete;

    const ungrouped = sidebar.querySelector('[data-session-section="ungrouped"]');
    expect(ungrouped?.querySelector(".sidebar-recent-sessions__head")).toBeNull();
    expect(ungrouped?.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
  });

  it("marks the toolbar filter when the status is not active", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:other"]),
    );
    const filter = sidebar.querySelector<HTMLButtonElement>(
      ".sidebar-session-toolbar .sidebar-session-sort",
    );
    expect(filter?.getAttribute("aria-label")).toBe("Filter & sort · Active");
    expect(filter?.classList.contains("sidebar-session-sort--filtered")).toBe(false);

    await activateSessionMenuValue(sidebar, "status:all");

    expect(filter?.classList.contains("sidebar-session-sort--filtered")).toBe(true);
  });

  it("hides empty Other at rest but keeps empty categories and the drag drop target", async () => {
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:alpha"]);
    const alpha = harness.row("agent:main:alpha");
    alpha.category = "Alpha";
    alpha.pinned = true;
    harness.publish({ groups: ["Empty", "Alpha"] });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    await activateSessionMenuValue(sidebar, "empty-groups:never");

    // Never keeps empty user-created groups as creation and drag targets;
    // only the bare Other header disappears while nothing lives in it.
    const emptyCategory = sidebar.querySelector('[data-session-section="category:Empty"]');
    const emptyCategoryHeader = emptyCategory?.querySelector(
      ":scope > .sidebar-recent-sessions__head",
    );
    expect(emptyCategory).not.toBeNull();
    expect(emptyCategoryHeader).not.toBeNull();
    expect(emptyCategory?.querySelector(".sidebar-session-group-toggle")?.textContent).toContain(
      "Empty",
    );
    expect(emptyCategory?.querySelector(".sidebar-session-empty-hint")).toBeNull();
    expect(emptyCategory?.querySelector(".sidebar-recent-sessions__list")).toBeNull();
    expect(emptyCategory?.children).toHaveLength(1);
    expect(emptyCategory?.firstElementChild).toBe(emptyCategoryHeader);
    expect(sidebar.querySelector('[data-session-section="ungrouped"]')).toBeNull();

    sidebar.sessionOrganizer.draggingSessionKey = "agent:main:alpha";
    sidebar.invalidate();
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-section="ungrouped"]')).not.toBeNull();
  });

  it("persists hiding empty groups without hiding collapsed populated groups", async () => {
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:alpha"]);
    const alpha = harness.sessions.state.result!.sessions.find(
      (row) => row.key === "agent:main:alpha",
    )!;
    alpha.category = "Alpha";
    harness.publish({ groups: ["Empty", "Alpha"] });
    const gateway = createGateway({} as GatewayBrowserClient);
    const mounted = await mountSidebar(gateway, harness.sessions);
    let sidebar = mounted.sidebar;
    await activateSessionMenuValue(sidebar, "empty-groups:never");
    sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set(["category:Alpha"]));
    await sidebar.updateComplete;

    const groupNames = () =>
      [...sidebar.querySelectorAll("[data-session-section^='category:']")].map((group) =>
        group.getAttribute("data-session-section"),
      );
    const chooseEmptyGroups = async (mode: "filtering" | "always" | "never") => {
      await activateSessionMenuValue(sidebar, `empty-groups:${mode}`);
    };

    expect(groupNames()).toEqual(["category:Empty", "category:Alpha"]);
    await chooseEmptyGroups("always");
    expect(groupNames()).toEqual(["category:Alpha"]);

    mounted.provider.remove();
    ({ sidebar } = await mountSidebar(gateway, harness.sessions));
    expect(groupNames()).toEqual(["category:Alpha"]);
    expect(sidebar.querySelector('[data-session-key="agent:main:alpha"]')).toBeNull();

    // Membership changes reveal and hide groups without changing the preference.
    const result = harness.sessions.state.result!;
    harness.publishList({
      result: {
        ...result,
        sessions: result.sessions.with(result.sessions.indexOf(alpha), {
          ...alpha,
          category: "Empty",
        }),
      },
      groups: ["Empty", "Alpha"],
    });
    await settleLitElement(sidebar);
    expect(groupNames()).toEqual(["category:Empty"]);
    await chooseEmptyGroups("never");
    expect(groupNames()).toEqual(["category:Empty", "category:Alpha"]);
  });

  it("renders no chat rows when only the main session exists", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    await sidebar.updateComplete;

    // The identity card is the main-session entry; the list stays empty.
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(0);
    expect(sidebar.querySelector("openclaw-sidebar-agent-card")).not.toBeNull();
  });

  it("keeps a selected child reachable when its parent is outside the loaded window", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:child"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: sessionListResult(2, [
        {
          key: "agent:main:child",
          spawnedBy: "agent:main:missing-parent",
          kind: "direct",
          label: "Reachable orphan",
          updatedAt: 2,
          status: "done",
        },
      ]),
    });
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:child";
    await sidebar.updateComplete;

    const row = sidebar.querySelector('[data-session-key="agent:main:child"]');
    expect(row?.textContent).toContain("Reachable orphan");
    expect(row?.classList.contains("sidebar-recent-session--child")).toBe(false);
  });
});
