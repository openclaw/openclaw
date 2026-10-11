/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { DashboardsView, type DashboardGalleryFilters, type DashboardsRouteData } from "./view.tsx";

const filters: DashboardGalleryFilters = { query: "", ownerId: "", sort: "updated" };
const handlers = {
  onFilterChange: vi.fn(),
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
      const [value, setValue] = createSignal<DashboardsRouteData>();
      const { container } = mountSolid(() => (
        <DashboardsView data={value()} filters={filters} handlers={handlers} />
      ));

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
      setValue(data);
      flush();

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
      const onNavigate = vi.fn();
      const { container } = mountSolid(() => (
        <DashboardsView
          data={routeData(
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
          )}
          filters={filters}
          handlers={{ onFilterChange: vi.fn(), onNavigate }}
        />
      ));

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

  it("explains how to create a dashboard when the list is empty", () => {
    const { container } = mountSolid(() => (
      <DashboardsView data={routeData([])} filters={filters} handlers={handlers} />
    ));

    const empty = container.querySelector("[data-dashboards-empty]");
    expect(empty?.textContent).toContain("No dashboards yet");
    expect(empty?.textContent).toContain("Dashboards created in your tasks will appear here");
  });
});
