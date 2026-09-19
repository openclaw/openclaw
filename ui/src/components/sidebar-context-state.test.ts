/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { committedRouterState } from "../app/app-host.test-support.ts";
import { equalSidebarContext, selectSidebarContext } from "./sidebar-context-state.ts";

describe("sidebar route state", () => {
  it("binds contextual navigation to the same rendered route as the workspace", () => {
    const data = { source: "host" };
    const renderSidebar = vi.fn(() => "Machine inventory");
    const state = committedRouterState("systems", "/systems", data);
    Object.assign(state.matches[0]!, { status: "success", module: { renderSidebar } });
    const sidebar = selectSidebarContext(state);
    expect(sidebar?.key).toBe("systems");
    expect(sidebar?.render(sidebar.data, sidebar.loaderPending, true)).toBe("Machine inventory");
    expect(renderSidebar).toHaveBeenCalledWith(data, false, true);

    // A cold import keeps the current main page, so its contextual list stays too.
    state.pendingMatches = [
      { ...state.matches[0]!, routeId: "tasks", status: "pending", module: undefined },
    ];
    expect(selectSidebarContext(state)?.key).toBe("systems");
    Object.assign(state.pendingMatches[0]!, { status: "error", error: new Error("Route failed") });
    expect(selectSidebarContext(state)).toBeUndefined();
  });

  it("updates a contextual sidebar when its loader settles without a route change", () => {
    const renderSidebar = vi.fn(() => "Machine inventory");
    const state = committedRouterState("systems", "/systems");
    Object.assign(state.matches[0]!, {
      status: "pending",
      module: { renderSidebar },
      isFetching: "loader",
    });
    const pending = selectSidebarContext(state);
    expect(equalSidebarContext(pending, selectSidebarContext(state))).toBe(true);
    const data = { source: "Gateway" };
    Object.assign(state.matches[0]!, { status: "success", data, isFetching: false });
    const ready = selectSidebarContext(state);
    expect(equalSidebarContext(pending, ready)).toBe(false);
    expect(equalSidebarContext(ready, selectSidebarContext(state))).toBe(true);
    Object.assign(state.matches[0]!, { data: { source: "Worker" } });
    expect(equalSidebarContext(ready, selectSidebarContext(state))).toBe(false);
    Object.assign(state.matches[0]!, { status: "error", error: new Error("Unavailable") });
    expect(selectSidebarContext(state)).toBeUndefined();
    expect(equalSidebarContext(ready, selectSidebarContext(state))).toBe(false);
  });
});
