import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  panelTabStripStyles,
  renderPanelTabStrip,
  type PanelTabStripTab,
} from "./panel-tab-strip.ts";

type RenderedTab = HTMLElement & {
  active: boolean;
  panel: string;
};

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

function tab(id: string): PanelTabStripTab {
  return {
    id,
    domId: `browser-test-tab-${id}`,
    label: `Tab ${id.toUpperCase()}`,
    closeLabel: `Close tab ${id.toUpperCase()}`,
  };
}

function renderControlledStrip(params: {
  container: HTMLElement | DocumentFragment;
  tabs: PanelTabStripTab[];
  activeId: string;
  ariaControls?: string | ((tab: PanelTabStripTab) => string);
  onSelect: (id: string) => void;
  onClose?: (id: string) => void | Promise<void>;
}) {
  render(
    renderPanelTabStrip({
      tabs: params.tabs,
      activeId: params.activeId,
      ariaControls: params.ariaControls ?? "browser-test-panel",
      onSelect: params.onSelect,
      onClose: params.onClose ?? vi.fn(),
      onNew: vi.fn(),
      newLabel: "New tab",
    }),
    params.container,
  );
}

function renderedTabs(container: ParentNode): RenderedTab[] {
  return [...container.querySelectorAll<RenderedTab>(".tabstrip-tab")];
}

function tabWithId(container: ParentNode, id: string): RenderedTab | undefined {
  return renderedTabs(container).find((candidate) => candidate.panel === id);
}

async function settleTabLayout(container: ParentNode) {
  await container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(".tabstrip")
    ?.updateComplete;
  await new Promise(requestAnimationFrame);
}

async function expectOverflowTabVisible(container: ParentNode, selectedTab: HTMLElement) {
  await settleTabLayout(container);
  const viewport = container
    .querySelector(".tabstrip")
    ?.shadowRoot?.querySelector<HTMLElement>(".nav");
  if (!viewport) {
    throw new Error("expected rendered tab strip viewport");
  }
  const viewportRect = viewport.getBoundingClientRect();
  const tabRect = selectedTab.getBoundingClientRect();
  expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
  expect(tabRect.left).toBeGreaterThanOrEqual(viewportRect.left - 1);
  expect(tabRect.right).toBeLessThanOrEqual(viewportRect.right + 1);
}

async function expectControlledSelection(
  container: ParentNode,
  activeId: string,
): Promise<RenderedTab> {
  let active: RenderedTab | undefined;
  await vi.waitFor(() => {
    const tabs = renderedTabs(container);
    const selected = tabs.filter(
      (candidate) =>
        candidate.active ||
        candidate.hasAttribute("active") ||
        candidate.getAttribute("aria-selected") === "true",
    );
    active = tabWithId(container, activeId);
    expect(selected).toEqual([active]);
    expect(active?.tabIndex).toBe(0);
    expect(
      tabs
        .filter((candidate) => candidate !== active)
        .every((candidate) => candidate.tabIndex === -1),
    ).toBe(true);
  });
  return active!;
}

afterEach(() => {
  document.body.replaceChildren();
  document.querySelector("#panel-tab-strip-browser-test-styles")?.remove();
});

describe.skipIf(!hasBrowserLayout)("panel tab strip browser lifecycle", () => {
  it("preserves the focused active element when tabs reorder", async () => {
    const host = document.createElement("div");
    const container = host.attachShadow({ mode: "open" });
    document.body.append(host);
    const tabs = [tab("a"), tab("b"), tab("c")];
    renderControlledStrip({ container, tabs, activeId: "b", onSelect: vi.fn() });
    const initialActive = await expectControlledSelection(container, "b");
    initialActive.focus();
    expect(document.activeElement).toBe(host);
    expect(container.activeElement).toBe(initialActive);

    queueMicrotask(() => initialActive.blur());
    renderControlledStrip({
      container,
      tabs: [tabs[2]!, { ...tabs[1]!, label: "Tab B navigated" }, tabs[0]!],
      activeId: "b",
      onSelect: vi.fn(),
    });
    const reorderedActive = await expectControlledSelection(container, "b");

    expect(reorderedActive).toBe(initialActive);
    await vi.waitFor(() => expect(container.activeElement).toBe(initialActive));

    renderControlledStrip({
      container,
      tabs: [tabs[2]!, tab("d"), tabs[1]!, tabs[0]!],
      activeId: "b",
      onSelect: vi.fn(),
    });
    const insertedActive = await expectControlledSelection(container, "b");
    expect(insertedActive).toBe(initialActive);
    expect(container.activeElement).toBe(initialActive);

    const unrelated = document.createElement("button");
    unrelated.textContent = "Unrelated action";
    document.body.append(unrelated);
    unrelated.focus();
    renderControlledStrip({
      container,
      tabs: [tabs[0]!, tabs[1]!, tabs[2]!],
      activeId: "b",
      onSelect: vi.fn(),
    });
    expect(await expectControlledSelection(container, "b")).toBe(initialActive);
    await settleTabLayout(container);
    expect(document.activeElement).toBe(unrelated);
  });

  it("keeps arrow and mouse activation controlled and the selected overflow tab visible", async () => {
    const style = document.createElement("style");
    style.id = "panel-tab-strip-browser-test-styles";
    style.textContent = panelTabStripStyles.cssText;
    document.head.append(style);
    const container = document.createElement("div");
    container.style.width = "220px";
    document.body.append(container);
    const tabs = Array.from({ length: 8 }, (_, index) => tab(String(index + 1)));
    let activeId = "4";
    const onSelect = vi.fn((nextId: string) => {
      activeId = nextId;
      renderControlledStrip({ container, tabs, activeId, onSelect });
    });
    renderControlledStrip({ container, tabs, activeId, onSelect });
    const initialActive = await expectControlledSelection(container, activeId);
    initialActive.focus();
    initialActive.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        composed: true,
      }),
    );
    await vi.waitFor(() => expect(activeId).toBe("5"));
    const arrowActive = await expectControlledSelection(container, activeId);
    expect(document.activeElement).toBe(arrowActive);

    const last = tabWithId(container, "8");
    last?.click();
    await vi.waitFor(() => expect(activeId).toBe("8"));
    const lastActive = await expectControlledSelection(container, activeId);
    await expectOverflowTabVisible(container, lastActive);
  });

  it.each(["shared", "per-tab"])(
    "restores close focus with %s content targets",
    async (targets) => {
      const neighbor = document.createElement("div");
      document.body.append(neighbor);
      renderControlledStrip({
        container: neighbor,
        tabs: [
          { ...tab("a"), domId: "neighbor-a" },
          { ...tab("b"), domId: "neighbor-b" },
        ],
        activeId: "a",
        ariaControls: "neighbor-panel",
        onSelect: vi.fn(),
      });
      await expectControlledSelection(neighbor, "a");
      let container = document.createElement("div");
      document.body.append(container);
      const close = createDeferred();
      let tabs = [tab("a"), tab("b")];
      let activeId = "a";
      const onSelect = vi.fn();
      const ariaControls =
        targets === "shared"
          ? "browser-test-panel"
          : (entry: PanelTabStripTab) => `panel-${entry.id}`;
      const onClose = vi.fn((closedId: string) =>
        close.promise.then(() => {
          (document.activeElement as HTMLElement | null)?.blur();
          tabs = tabs.filter((entry) => entry.id !== closedId);
          activeId = tabs[0]?.id ?? "";
          const replacement = document.createElement("div");
          container.replaceWith(replacement);
          container = replacement;
          renderControlledStrip({ container, tabs, activeId, ariaControls, onSelect, onClose });
        }),
      );
      renderControlledStrip({ container, tabs, activeId, ariaControls, onSelect, onClose });
      await expectControlledSelection(container, activeId);
      expect(renderedTabs(container).map((entry) => entry.getAttribute("aria-controls"))).toEqual(
        targets === "shared"
          ? ["browser-test-panel", "browser-test-panel"]
          : ["panel-a", "panel-b"],
      );
      const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");
      closeButton?.focus();
      expect(document.activeElement).toBe(closeButton);

      closeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      closeButton?.blur();
      closeButton?.click();
      close.resolve();
      await close.promise;
      await Promise.resolve();

      const fallback = await expectControlledSelection(container, activeId);
      await settleTabLayout(container);
      expect(document.activeElement).toBe(fallback);
    },
  );
});
