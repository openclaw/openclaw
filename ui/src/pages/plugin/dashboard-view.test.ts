import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getDashboardState } from "../../lib/dashboard/index.ts";
import { stopDashboard } from "./dashboard-controller.ts";
import {
  navigateToWorkspaceTab,
  renderDashboard,
  requestedWorkspaceSlug,
} from "./dashboard-view.ts";

function renderView(host: object): HTMLElement {
  const container = document.createElement("div");
  // The view queries `.dashboard-grid` on the host for grid metrics.
  const el = container as unknown as object;
  render(renderDashboard({ host: el, client: null, connected: false }), container);
  render(renderDashboard({ host, client: null, connected: false }), container);
  return container;
}

const doc = {
  schemaVersion: 1,
  workspaceVersion: 1,
  tabs: [
    {
      slug: "main",
      title: "Main",
      hidden: false,
      widgets: [
        {
          id: "w1",
          kind: "builtin:markdown",
          title: "Notes",
          grid: { x: 0, y: 0, w: 6, h: 2 },
          collapsed: false,
          props: { markdown: "hello" },
        },
      ],
    },
    { slug: "hidden-one", title: "Hidden", hidden: true, widgets: [] },
    { slug: "empty", title: "Empty", hidden: false, widgets: [] },
  ],
  widgetsRegistry: {},
  prefs: { tabOrder: ["main", "empty", "hidden-one"] },
};

describe("requestedWorkspaceSlug", () => {
  it("reads the ws deep-link param", () => {
    expect(requestedWorkspaceSlug("?plugin=dashboard&id=workspaces&ws=financials")).toBe(
      "financials",
    );
    expect(requestedWorkspaceSlug("?plugin=dashboard&id=workspaces")).toBeNull();
  });
});

describe("navigateToWorkspaceTab", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("pushes a ws query param and dispatches popstate", () => {
    window.history.replaceState({}, "", "/plugin?plugin=dashboard&id=workspaces");
    let popped = false;
    const onPop = () => {
      popped = true;
    };
    window.addEventListener("popstate", onPop);
    navigateToWorkspaceTab("financials");
    window.removeEventListener("popstate", onPop);
    expect(new URLSearchParams(window.location.search).get("ws")).toBe("financials");
    expect(popped).toBe(true);
  });
});

describe("renderDashboard", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("shows the onboarding empty state with no tabs", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [],
      widgetsRegistry: {},
      prefs: { tabOrder: [] },
    };
    const container = renderView(host);
    expect(container.querySelector('[data-test-id="dashboard-empty"]')).not.toBeNull();
  });

  it("renders the tab strip with visible tabs and a hidden overflow", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    const container = renderView(host);
    const tabs = container.querySelectorAll('[data-test-id="dashboard-tab"]');
    expect(tabs.length).toBe(2); // main + empty (hidden-one is in overflow)
    expect(container.querySelector(".dashboard-tabs__hidden")).not.toBeNull();
    // Active tab's widget grid renders.
    expect(container.querySelector('[data-test-id="dashboard-grid"]')).not.toBeNull();
  });

  it("renders the empty-tab hint for a tab with no widgets", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "empty";
    const container = renderView(host);
    expect(container.querySelector('[data-test-id="dashboard-empty-tab"]')).not.toBeNull();
  });

  it("surfaces an action error toast", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    state.actionError = "move failed";
    const container = renderView(host);
    expect(container.querySelector(".dashboard__toast")?.textContent).toContain("move failed");
  });
});

describe("drag ghost (#4)", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders a snapped drop-target ghost while a drag is in flight", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const client = {
      request: vi.fn(async () => ({})),
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    try {
      render(renderDashboard({ host, client, connected: true }), host);
      const grid = host.querySelector<HTMLElement>(".dashboard-grid");
      Object.defineProperty(grid, "clientWidth", { value: 720, configurable: true });
      // No ghost before a drag begins.
      expect(host.querySelector('[data-test-id="dashboard-drag-ghost"]')).toBeNull();
      const bar = host.querySelector<HTMLElement>(".dashboard-widget__bar");
      bar!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
      render(renderDashboard({ host, client, connected: true }), host);
      // The ghost is present during the drag.
      expect(host.querySelector('[data-test-id="dashboard-drag-ghost"]')).not.toBeNull();
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));
      render(renderDashboard({ host, client, connected: true }), host);
      // Ghost gone once the drag settles.
      expect(host.querySelector('[data-test-id="dashboard-drag-ghost"]')).toBeNull();
    } finally {
      stopDashboard(host);
      host.remove();
    }
  });
});

describe("mid-drag tab-switch cancellation", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("cancels an in-flight drag on stopDashboard so a later pointerup is a no-op", () => {
    // The host IS the render container so gridMetrics/pointer targets resolve.
    const host = document.createElement("div");
    document.body.append(host);
    const request = vi.fn(async (..._args: unknown[]) => ({}));
    const client = {
      request,
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    render(renderDashboard({ host, client, connected: true }), host);

    // Grid clientWidth is 0 in jsdom; stub a real width so the drag begins.
    const grid = host.querySelector<HTMLElement>(".dashboard-grid");
    expect(grid).not.toBeNull();
    Object.defineProperty(grid, "clientWidth", { value: 720, configurable: true });

    // Track window pointer listeners added during the drag.
    const added = new Set<string>();
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    const addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type: string, ...rest: unknown[]) => {
        if (type === "pointermove" || type === "pointerup") {
          added.add(type);
        }
        return (originalAdd as (t: string, ...r: unknown[]) => void)(type, ...rest);
      });
    const removeSpy = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation((type: string, ...rest: unknown[]) => {
        if (type === "pointermove" || type === "pointerup") {
          added.delete(type);
        }
        return (originalRemove as (t: string, ...r: unknown[]) => void)(type, ...rest);
      });

    try {
      const bar = host.querySelector<HTMLElement>(".dashboard-widget__bar");
      expect(bar).not.toBeNull();
      bar!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
      // The drag registered its window listeners.
      expect(added.has("pointermove")).toBe(true);
      expect(added.has("pointerup")).toBe(true);

      // Operator switches tabs mid-drag → the bundled view's stop hook fires.
      stopDashboard(host);

      // Listeners are gone…
      expect(added.has("pointermove")).toBe(false);
      expect(added.has("pointerup")).toBe(false);

      // …and a late pointerup does not resolve a move against the stale tab/client.
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 400, clientY: 200 }));
      expect(request.mock.calls.some(([method]) => method === "dashboard.widget.move")).toBe(false);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      host.remove();
    }
  });
});
