/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { renderDashboards, type DashboardsRouteData } from "./view.ts";

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
      render(renderDashboards(undefined), container);

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
      render(renderDashboards(data), container);

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
      render(
        renderDashboards(
          routeData(
            [
              {
                key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
                kind: "direct",
                boardFace: "dashboard",
                displayName: "Deploy monitor",
                updatedAt: 2,
              },
            ],
            basePath,
          ),
        ),
        container,
      );

      const row = container.querySelector<HTMLElement>("[data-dashboard-session]");
      expect(row?.textContent).toContain("Deploy monitor");
      expect(
        row?.querySelector<HTMLAnchorElement>(".dashboard-card__main")?.getAttribute("href"),
      ).toBe(`${basePath}/dashboard/main/deploy-monitor-12345678`);
    },
  );

  it("explains how to create a dashboard when the list is empty", () => {
    const container = document.createElement("div");
    render(renderDashboards(routeData([])), container);

    const empty = container.querySelector("[data-dashboards-empty]");
    expect(empty?.textContent).toContain("No dashboards yet");
    expect(empty?.textContent).toContain("Dashboards created in your tasks will appear here");
  });
});
