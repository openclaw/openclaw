import { describe, expect, it, vi } from "vitest";
import { agentIds, mountRoster, session, sessionKeys } from "./roster.test-support.ts";

describe("team named categories", () => {
  it.each(["none", "category", "person", "project"])(
    "preserves categories without changing the %s single-agent preference",
    async (grouping) => {
      const now = Date.now();
      const rows = [
        session("main", now),
        session("recent", now),
        session("main", now - 1, {
          key: "agent:main:plan",
          isMain: false,
          category: "Planning",
          label: "Harbor plan",
        }),
        session("recent", now - 2, {
          key: "agent:recent:plan",
          isMain: false,
          category: "Planning",
          label: "Scout plan",
        }),
        session("main", now - 3, {
          key: "agent:main:pin",
          isMain: false,
          category: "Planning",
          pinned: true,
          label: "Pinned plan",
        }),
        session("main", now - 4, { key: "agent:main:other", isMain: false, label: "Unfiled" }),
      ];
      const { sidebar, request } = await mountRoster(undefined, rows);
      Object.assign(sidebar, { sessionsGrouping: grouping, sidebarAgentsMode: "roster" });
      await sidebar.updateComplete;
      await vi.waitFor(() => expect(agentIds(sidebar)).toContain("main"));
      const main = sidebar.querySelector('[data-agent-group="main"]')!;
      const other = sidebar.querySelector('[data-agent-group="recent"]')!;
      await vi.waitFor(() =>
        expect(
          main.querySelector('[data-session-section="agent:main:category:Planning"]'),
        ).not.toBeNull(),
      );
      expect(
        other.querySelector('[data-session-section="agent:recent:category:Planning"]'),
      ).not.toBeNull();
      expect(sessionKeys(sidebar).filter((key) => key === "agent:main:pin")).toHaveLength(1);
      expect(main.querySelector(".sidebar-agent-roster__row")).not.toBeNull();
      expect(sidebar.querySelector(".sidebar-session-group-actions")).toBeNull();
      expect(sidebar.querySelector(".sidebar-session-section-drag-handle")).toBeNull();
      const header = main.querySelector<HTMLButtonElement>(
        '[data-session-section="agent:main:category:Planning"] .sidebar-session-group-toggle',
      )!;
      const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      header.dispatchEvent(contextMenu);
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-session-group-menu")).toBeNull();
      header.click();
      await sidebar.updateComplete;
      await vi.waitFor(() =>
        expect(main.querySelector('[data-session-key="agent:main:plan"]')).toBeNull(),
      );
      expect(other.querySelector('[data-session-key="agent:recent:plan"]')).not.toBeNull();
      expect(main.querySelector(".sidebar-session-group-count")).toBeNull();
      main.querySelector<HTMLButtonElement>('[data-agent-collapse="main"]')!.click();
      await vi.waitFor(() =>
        expect(main.querySelector('[data-session-key="agent:main:pin"]')).toBeNull(),
      );
      expect(other.querySelector('[data-session-key="agent:recent:plan"]')).not.toBeNull();
      expect(main.querySelector(".sidebar-agent-roster__row")).not.toBeNull();
      expect(Reflect.get(sidebar, "sessionsGrouping")).toBe(grouping);
      expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
    },
  );

  it("keeps categorized Home children in their category once, without changing Home navigation", async () => {
    const now = Date.now();
    const child = "agent:main:project";
    const { sidebar } = await mountRoster(undefined, [
      session("main", now, { childSessions: [child] }),
      session("main", now - 1, {
        key: child,
        isMain: false,
        spawnedBy: "agent:main:main",
        category: "Planning",
        label: "Home project",
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => {
      expect(
        sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__row'),
      ).not.toBeNull();
      expect(
        sidebar.querySelector(
          '[data-session-section="agent:main:category:Planning"] [data-session-key="agent:main:project"]',
        ),
      ).not.toBeNull();
    });
    await vi.waitFor(() =>
      expect(sessionKeys(sidebar).filter((key) => key === child)).toHaveLength(1),
    );
    const section = sidebar.querySelector('[data-session-section="agent:main:category:Planning"]');
    expect(section?.querySelector('[data-session-key="agent:main:project"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:main"]')).toBeNull();
    expect(
      sidebar
        .querySelector('[data-agent-group="main"] .sidebar-agent-roster__row')
        ?.getAttribute("href"),
    ).toContain("/chat");
  });
});
