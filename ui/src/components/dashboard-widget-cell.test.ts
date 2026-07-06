import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DashboardWidget } from "../lib/dashboard/types.ts";
import type { BuiltinWidgetContext } from "../lib/dashboard/widgets/index.ts";
import {
  displayWidgetTitle,
  renderWidgetBody,
  renderWidgetCell,
  type DashboardWidgetCellCallbacks,
} from "./dashboard-widget-cell.ts";

const BUILTIN_CONTEXT: BuiltinWidgetContext = {
  embed: { embedSandboxMode: "strict", allowExternalEmbedUrls: false },
};

function noopCallbacks(): DashboardWidgetCellCallbacks {
  return {
    onToggleCollapse: vi.fn(),
    onToggleMenu: vi.fn(),
    onHide: vi.fn(),
    onRemove: vi.fn(),
    onEditTitle: vi.fn(),
    onMoveToTab: vi.fn(),
    onMovePointerDown: vi.fn(),
    onResizePointerDown: vi.fn(),
    onKeyboardNudge: vi.fn(),
  };
}

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id: "w1",
    kind: "builtin:stat-card",
    title: "Revenue",
    grid: { x: 0, y: 0, w: 4, h: 2 },
    collapsed: false,
    ...overrides,
  };
}

function renderToContainer(template: unknown): HTMLElement {
  const container = document.createElement("div");
  render(template as never, container);
  return container;
}

describe("dashboard widget cell", () => {
  it("renders the title bar with collapse and menu affordances", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget(),
        binding: { value: 1000 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".dashboard-widget__title")?.textContent).toContain("Revenue");
    expect(container.querySelector(".dashboard-widget__collapse")).not.toBeNull();
    expect(container.querySelector(".dashboard-widget__menu-toggle")).not.toBeNull();
    // Not collapsed → body + resize handle present.
    expect(container.querySelector(".dashboard-widget__resize")).not.toBeNull();
  });

  it("strips a trailing (custom) suffix from the visible title but keeps the full title attr (#8)", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ title: "Revenue (custom)" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    const title = container.querySelector(".dashboard-widget__title");
    expect(title?.textContent?.trim()).toBe("Revenue");
    expect(title?.getAttribute("title")).toBe("Revenue (custom)");
  });

  it("displayWidgetTitle drops only a trailing (custom) suffix (#8)", () => {
    expect(displayWidgetTitle("Notes (custom)")).toBe("Notes");
    expect(displayWidgetTitle("Notes")).toBe("Notes");
    expect(displayWidgetTitle("My (custom) widget")).toBe("My (custom) widget");
    // Degenerate: a bare suffix falls back to the original rather than an empty title.
    expect(displayWidgetTitle("(custom)")).toBe("(custom)");
  });

  it("renders a provenance chip for agent-authored widgets", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ createdBy: "agent:finance" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    const chip = container.querySelector(".dashboard-widget__provenance");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toContain("finance");
  });

  it("omits the provenance chip for user-authored widgets", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ createdBy: "user" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".dashboard-widget__provenance")).toBeNull();
  });

  it("hides the body and resize handle when collapsed", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ collapsed: true }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".dashboard-widget__body")).toBeNull();
    expect(container.querySelector(".dashboard-widget__resize")).toBeNull();
  });

  it("opens the kebab menu with hide/remove/edit/move items", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget(),
        binding: { value: 1 },
        menuOpen: true,
        pending: false,
        dragging: false,
        builtinContext: BUILTIN_CONTEXT,
        callbacks: noopCallbacks(),
      }),
    );
    const items = container.querySelectorAll(".dashboard-widget__menu-item");
    expect(items.length).toBe(4);
  });

  it("renders a stat-card value formatted as currency", () => {
    const container = renderToContainer(
      renderWidgetBody(
        widget({ props: { format: "usd", label: "Q3 Revenue" } }),
        { value: 1234 },
        BUILTIN_CONTEXT,
        noopCallbacks(),
      ),
    );
    expect(container.querySelector(".dashboard-stat__value")?.textContent).toContain("$1,234");
    expect(container.querySelector(".dashboard-stat__label")?.textContent).toContain("Q3 Revenue");
  });

  it("renders markdown widget content", () => {
    const container = renderToContainer(
      renderWidgetBody(
        widget({ kind: "builtin:markdown" }),
        { value: "# Hello" },
        BUILTIN_CONTEXT,
        noopCallbacks(),
      ),
    );
    expect(container.querySelector(".dashboard-markdown h1")?.textContent).toContain("Hello");
  });

  it("catches a widget render throw with a per-cell error card", () => {
    // A binding error triggers the error boundary; the card stays mounted.
    const container = renderToContainer(
      renderWidgetBody(widget(), { error: "binding failed" }, BUILTIN_CONTEXT, noopCallbacks()),
    );
    const errorCard = container.querySelector('[data-test-id="dashboard-widget-error"]');
    expect(errorCard).not.toBeNull();
    expect(errorCard?.textContent).toContain("binding failed");
  });

  it("renders a placeholder for custom widgets in this layer (custom host is L5)", () => {
    const container = renderToContainer(
      renderWidgetBody(widget({ kind: "custom:chart" }), null, BUILTIN_CONTEXT, noopCallbacks()),
    );
    expect(container.querySelector(".dashboard-widget__placeholder")).not.toBeNull();
    // The sandboxed iframe host does not exist in this layer.
    expect(container.querySelector("iframe")).toBeNull();
  });
});
