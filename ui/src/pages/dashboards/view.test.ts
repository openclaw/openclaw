/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { renderDashboards, type DashboardGalleryState, type DashboardsRouteData } from "./view.ts";

function routeData(sessions: SessionsListResult["sessions"], basePath = ""): DashboardsRouteData {
  return {
    result: {
      ts: 1,
      path: "(multiple)",
      count: sessions.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions,
    },
    error: null,
    basePath,
    fallbackAgentId: "main",
    mainKey: "main",
  };
}

function galleryState(overrides: Partial<DashboardGalleryState> = {}): DashboardGalleryState {
  return {
    filters: { query: "", ownerId: "", sort: "updated" },
    view: "cards",
    ...overrides,
  };
}

const deployMonitor: SessionsListResult["sessions"][number] = {
  key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
  kind: "direct",
  boardFace: "dashboard",
  displayName: "Deploy monitor",
  createdAt: 1,
  updatedAt: 2,
};

function renderInto(
  data: DashboardsRouteData,
  state: DashboardGalleryState = galleryState(),
): HTMLDivElement {
  const container = document.createElement("div");
  render(renderDashboards(data, vi.fn(), state), container);
  return container;
}

describe("dashboards index", () => {
  it.each(["", "/openclaw"])(
    "links each card to its chat with the panel expanded and to focus mode at %s",
    (basePath) => {
      const container = renderInto(routeData([deployMonitor], basePath));

      const card = container.querySelector<HTMLElement>("[data-dashboard-session]");
      expect(card?.classList.contains("dashboard-card")).toBe(true);
      expect(card?.textContent).toContain("Deploy monitor");
      expect(
        card?.querySelector<HTMLAnchorElement>(".dashboard-card__main")?.getAttribute("href"),
      ).toBe(`${basePath}/chat/main/deploy-monitor-12345678?dashboard=expanded`);
      const focus = card?.querySelector<HTMLAnchorElement>("[data-dashboard-fullscreen]");
      expect(focus?.getAttribute("href")).toBe(
        `${basePath}/focus/dashboard/main/deploy-monitor-12345678`,
      );
      expect(focus?.hasAttribute("target")).toBe(false);
      expect(focus?.textContent?.trim()).toBe("Open in focus mode");
      // The focus link is a sibling of the card link, never nested inside it.
      expect(focus?.closest(".dashboard-card__main")).toBeNull();
    },
  );

  it("uses the shared 1120px page column and a view toggle in the header", () => {
    const container = renderInto(routeData([deployMonitor]));

    expect(container.querySelector(".settings-page.settings-page--wide")).not.toBeNull();
    const toggle = container.querySelector('[role="group"][aria-label="View"]');
    const buttons = toggle?.querySelectorAll<HTMLButtonElement>("[data-dashboards-view]") ?? [];
    expect(Array.from(buttons, (button) => button.dataset.dashboardsView)).toEqual([
      "cards",
      "list",
    ]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('.page-header-actions [aria-label="List"]')).not.toBeNull();
  });

  it("renders rows with a trailing preview in list view", () => {
    const container = renderInto(routeData([deployMonitor]), galleryState({ view: "list" }));

    const row = container.querySelector<HTMLElement>("[data-dashboard-session]");
    expect(row?.classList.contains("dashboard-row")).toBe(true);
    expect(container.querySelector('[data-dashboards-view="list"]')).not.toBeNull();
    const children = Array.from(row?.children ?? [], (child) => child.className);
    expect(children.at(-1)).toBe("dashboard-row__preview");
    expect(row?.querySelector(".dashboard-row__preview openclaw-dashboard-preview")).not.toBeNull();
    expect(row?.querySelector("[data-dashboard-fullscreen]")?.textContent?.trim()).toBe(
      "Open in focus mode",
    );
  });

  it("passes the row identity to the preview", () => {
    const load = vi.fn(async () => null);
    const container = renderInto(
      routeData([{ ...deployMonitor, agentId: "main", updatedAt: 42 }]),
      galleryState({ loadPreview: load }),
    );

    const preview = container.querySelector<
      HTMLElement & { sessionKey: string; agentId?: string; load?: unknown }
    >("openclaw-dashboard-preview");
    expect(preview?.sessionKey).toBe(deployMonitor.key);
    expect(preview?.agentId).toBe("main");
    expect(preview?.load).toBe(load);
  });

  it("orders by creation time and labels the timestamp accordingly", () => {
    const rows: SessionsListResult["sessions"] = [
      {
        ...deployMonitor,
        key: "agent:main:dashboard:newer-edit",
        displayName: "Newer edit",
        createdAt: 10,
        updatedAt: 300,
      },
      {
        ...deployMonitor,
        key: "agent:main:dashboard:newer-born",
        displayName: "Newer born",
        createdAt: 200,
        updatedAt: 100,
      },
    ];
    const container = renderInto(
      routeData(rows),
      galleryState({ filters: { query: "", ownerId: "", sort: "created" } }),
    );

    expect(
      Array.from(container.querySelectorAll(".dashboard-card__heading h2"), (heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Newer born", "Newer edit"]);
    expect(container.querySelector(".dashboard-card__footer")?.textContent).toContain("Created");
    expect(container.querySelector('select option[value="created"]')?.textContent).toBe(
      "Recently created",
    );
  });

  it("explains how to create a dashboard when the list is empty", () => {
    const container = renderInto(routeData([]));

    const empty = container.querySelector("[data-dashboards-empty]");
    expect(empty?.textContent).toContain("No dashboards yet");
    expect(empty?.textContent).toContain("Dashboards created in your tasks will appear here");
  });
});
