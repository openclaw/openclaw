/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import {
  renderDashboards,
  type DashboardGalleryFilters,
  type DashboardsRouteData,
} from "./view.ts";

const filters: DashboardGalleryFilters = {
  query: "",
  ownerId: "",
  sort: "updated",
  status: "active",
};
const handlers = {
  onQueryChange: vi.fn(),
  onOwnerChange: vi.fn(),
  onSortChange: vi.fn(),
  onStatusChange: vi.fn(),
};

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
    globalScope: false,
  };
}

describe("dashboards index", () => {
  it.each(["gallery", "empty", "error"] as const)(
    "replaces the accessible loading skeleton with the resolved %s state",
    (outcome) => {
      const container = document.createElement("div");
      render(renderDashboards(undefined, filters, handlers), container);

      const busy = container.querySelector('[aria-busy="true"]');
      expect(busy).not.toBeNull();
      const placeholders = busy?.querySelectorAll(".skeleton") ?? [];
      expect(placeholders.length).toBeGreaterThan(0);
      expect(busy?.querySelector(".dashboards-toolbar")).not.toBeNull();
      expect(busy?.querySelectorAll(".dashboards-grid .dashboard-preview").length).toBeGreaterThan(
        0,
      );
      for (const placeholder of placeholders) {
        expect(placeholder.closest('[aria-hidden="true"]')).not.toBeNull();
      }
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
      expect(busy?.querySelectorAll("a, button, input, select, textarea").length).toBe(0);

      const data = routeData(
        outcome === "gallery"
          ? [{ key: "agent:main:dashboard:release", kind: "direct", displayName: "Release health" }]
          : [],
      );
      if (outcome === "error") {
        data.result = null;
        data.error = "Dashboard service unavailable";
      }
      render(renderDashboards(data, filters, handlers), container);

      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
      expect(container.querySelector(".skeleton")).toBeNull();
      if (outcome === "gallery") {
        expect(container.querySelector("[data-dashboard-session]")?.textContent).toContain(
          "Release health",
        );
      } else if (outcome === "empty") {
        expect(container.querySelector("[data-dashboards-empty]")?.textContent).toContain(
          "No dashboards yet",
        );
      } else {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "Dashboard service unavailable",
        );
        expect(container.querySelector("[data-dashboards-empty]")).toBeNull();
      }
    },
  );

  it.each(["", "/openclaw"])(
    "links each dashboard to an ordinary open that respects presentation defaults at %s",
    (basePath) => {
      const container = document.createElement("div");
      const onNavigate = vi.fn();
      render(
        renderDashboards(
          routeData(
            [
              {
                key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
                kind: "direct",
                boardFace: "chat",
                displayName: "Deploy monitor",
                updatedAt: 2,
              },
            ],
            basePath,
          ),
          filters,
          { ...handlers, onNavigate },
        ),
        container,
      );

      const row = container.querySelector<HTMLElement>("[data-dashboard-session]");
      expect(row?.textContent).toContain("Deploy monitor");
      expect(
        row?.querySelector<HTMLAnchorElement>(".dashboard-card__main")?.getAttribute("href"),
      ).toBe(`${basePath}/dashboard/main/deploy-monitor-1234567890abcdef1234567890abcdef`);
      const link = row!.querySelector<HTMLAnchorElement>(".dashboard-card__main")!;
      let intercepted = false;
      container.addEventListener("click", (event) => {
        intercepted = event.defaultPrevented;
        // Observe the card's routing decision without navigating the jsdom document.
        event.preventDefault();
      });
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(intercepted).toBe(true);
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("dashboard", {
        pathname: `${basePath}/dashboard/main/deploy-monitor-1234567890abcdef1234567890abcdef`,
        search:
          "?__openclawSessionKey=agent%3Amain%3Adashboard%3A12345678-90ab-cdef-1234-567890abcdef",
      });

      for (const activation of [
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        const modified = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...activation,
        });
        link.dispatchEvent(modified);
        expect(intercepted).toBe(false);
      }
      const handled = new MouseEvent("click", { bubbles: true, cancelable: true });
      handled.preventDefault();
      link.dispatchEvent(handled);
      expect(onNavigate).toHaveBeenCalledOnce();
    },
  );

  it("lists archived dashboards only when the status filter includes them", () => {
    const container = document.createElement("div");
    const data = routeData([
      { key: "agent:main:dashboard:live", kind: "direct", displayName: "Live board", updatedAt: 2 },
      {
        key: "agent:main:dashboard:old",
        kind: "direct",
        displayName: "Old board",
        archived: true,
        updatedAt: 1,
      },
    ]);
    const titles = () =>
      Array.from(container.querySelectorAll(".dashboard-card__heading h2"), (heading) =>
        heading.textContent?.trim(),
      );
    const onStatusChange = vi.fn();

    render(renderDashboards(data, filters, { ...handlers, onStatusChange }), container);
    expect(titles()).toEqual(["Live board"]);
    expect(container.querySelector(".dashboard-card__archived")).toBeNull();
    const statusSelect = container.querySelectorAll<HTMLSelectElement>("select").item(2);
    statusSelect.value = "archived";
    statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("archived");

    render(renderDashboards(data, { ...filters, status: "archived" }, handlers), container);
    expect(titles()).toEqual(["Old board"]);
    const archived = container.querySelector('[data-dashboard-session="agent:main:dashboard:old"]');
    expect(archived?.classList.contains("dashboard-card--archived")).toBe(true);
    expect(archived?.querySelector(".dashboard-card__archived")?.textContent).toBe("Archived");

    render(renderDashboards(data, { ...filters, status: "all" }, handlers), container);
    expect(titles()).toEqual(["Live board", "Old board"]);

    // When the Active view hides every board, the hint names the Status filter.
    render(
      renderDashboards(routeData([{ ...data.result!.sessions[1]! }]), filters, handlers),
      container,
    );
    expect(container.querySelector("[data-dashboards-no-results]")?.textContent).toContain(
      "Try another search, author, or status.",
    );
  });

  it("opens card actions from the menu button and right-click instead of the browser menu", () => {
    const container = document.createElement("div");
    const sessionRow = {
      key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
      kind: "direct" as const,
      sessionId: "session-1",
      displayName: "Noon delivery",
    };
    render(renderDashboards(routeData([sessionRow]), filters, handlers), container);
    expect(container.querySelector(".dashboard-card__menu")).toBeNull();

    const onOpenCardMenu = vi.fn();
    const onNavigate = vi.fn();
    render(
      renderDashboards(routeData([sessionRow]), filters, {
        ...handlers,
        onNavigate,
        onOpenCardMenu,
      }),
      container,
    );
    const card = container.querySelector<HTMLElement>("[data-dashboard-session]")!;
    const button = card.querySelector<HTMLButtonElement>(".dashboard-card__menu")!;
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-label")).toContain("Noon delivery");
    button.click();
    expect(onOpenCardMenu).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: sessionRow.key, sessionId: "session-1" }),
      { x: expect.any(Number), y: expect.any(Number) },
      button,
    );
    expect(onNavigate).not.toHaveBeenCalled();

    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    });
    card.querySelector(".dashboard-card__main")!.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(onOpenCardMenu).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: sessionRow.key }),
      { x: 40, y: 60 },
      null,
    );
    expect(onOpenCardMenu).toHaveBeenCalledTimes(2);
  });

  it("explains how to create a dashboard when the list is empty", () => {
    const container = document.createElement("div");
    render(renderDashboards(routeData([]), filters, handlers), container);

    const empty = container.querySelector("[data-dashboards-empty]");
    expect(empty?.textContent).toContain("No dashboards yet");
    expect(empty?.textContent).toContain("Dashboards created in your tasks will appear here");
  });
});
