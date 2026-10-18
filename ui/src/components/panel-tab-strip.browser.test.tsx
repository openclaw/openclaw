import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  PanelTabStrip,
  type SolidPanelTabStripTab as PanelTabStripTab,
  type PanelTabStripProps,
} from "./panel-tab-strip-solid.tsx";
import { panelTabStripCss } from "./panel-tab-strip-styles.ts";

type RenderedTab = HTMLButtonElement;
const host = () => document.body.appendChild(document.createElement("div"));

const mountedStrips = new Map<
  HTMLElement | DocumentFragment,
  {
    update: (props: PanelTabStripProps<PanelTabStripTab>) => void;
    dispose: () => void;
  }
>();

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

function tab(id: string): PanelTabStripTab {
  return {
    id,
    domId: `browser-test-tab-${id}`,
    label: `Tab ${id.toUpperCase()}`,
    closeLabel: `Close tab ${id.toUpperCase()}`,
  };
}

async function renderControlledStrip(
  container: HTMLElement | DocumentFragment,
  tabs: PanelTabStripTab[],
  options: Partial<PanelTabStripProps<PanelTabStripTab>> = {},
) {
  const props: PanelTabStripProps<PanelTabStripTab> = {
    tabs,
    activeId: tabs[0]?.id ?? "",
    ariaControls: "browser-test-panel",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    newLabel: "New tab",
    ...options,
  };
  const mounted = mountedStrips.get(container);
  if (mounted) {
    mounted.update(props);
  } else {
    const [current, update] = createSignal(props);
    const dispose = render(() => <PanelTabStrip {...current()} />, container);
    mountedStrips.set(container, { update, dispose });
  }
  flush();
  await Promise.resolve();
}

function renderedTabs(container: ParentNode): RenderedTab[] {
  return [...container.querySelectorAll<RenderedTab>(".tabstrip-tab")];
}

function tabWithId(container: ParentNode, id: string): RenderedTab | undefined {
  return renderedTabs(container).find((candidate) => candidate.dataset.tabValue === id);
}

async function settleTabLayout() {
  flush();
  await new Promise(requestAnimationFrame);
}

async function expectOverflowTabVisible(container: ParentNode, selectedTab: HTMLElement) {
  await settleTabLayout();
  const viewport = container.querySelector<HTMLElement>(".tabstrip")!;
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
  flush();
  let active: RenderedTab | undefined;
  await vi.waitFor(() => {
    const tabs = renderedTabs(container);
    const selected = tabs.filter(
      (candidate) =>
        candidate.hasAttribute("active") || candidate.getAttribute("aria-selected") === "true",
    );
    active = tabWithId(container, activeId);
    expect(selected).toEqual([active]);
    expect(tabs.map((entry) => entry.tabIndex)).toEqual(
      tabs.map((entry) => (entry === active ? 0 : -1)),
    );
  });
  return active!;
}

afterEach(() => {
  for (const mounted of mountedStrips.values()) {
    mounted.dispose();
  }
  mountedStrips.clear();
  document.body.replaceChildren();
  document.querySelector("#panel-tab-strip-browser-test-styles")?.remove();
});

describe.skipIf(!hasBrowserLayout)("panel tab strip browser lifecycle", () => {
  it("preserves the focused active element when tabs reorder", async () => {
    const owner = host();
    const container = owner.attachShadow({ mode: "open" });
    const tabs = [tab("a"), tab("b"), tab("c")];
    const update = (next: PanelTabStripTab[]) =>
      renderControlledStrip(container, next, { activeId: "b" });
    await update(tabs);
    const initialActive = await expectControlledSelection(container, "b");
    initialActive.focus();
    expect(document.activeElement).toBe(owner);
    expect(container.activeElement).toBe(initialActive);

    for (const [index, reordered] of [
      [tabs[2]!, { ...tabs[1]!, label: "Tab B navigated" }, tabs[0]!],
      [tabs[2]!, tab("d"), tabs[1]!, tabs[0]!],
    ].entries()) {
      await update(reordered);
      expect(await expectControlledSelection(container, "b")).toBe(initialActive);
      if (index === 0) {
        await vi.waitFor(() => expect(container.activeElement).toBe(initialActive));
      } else {
        expect(container.activeElement).toBe(initialActive);
      }
    }

    const unrelated = document.createElement("button");
    document.body.append(unrelated);
    unrelated.focus();
    await update(tabs);
    expect(await expectControlledSelection(container, "b")).toBe(initialActive);
    await settleTabLayout();
    expect(document.activeElement).toBe(unrelated);
  });

  it("keeps arrow and mouse activation controlled and the selected overflow tab visible", async () => {
    const style = document.createElement("style");
    style.id = "panel-tab-strip-browser-test-styles";
    style.textContent = panelTabStripCss;
    document.head.append(style);
    const container = host();
    container.style.width = "220px";
    const tabs = Array.from({ length: 8 }, (_, index) => tab(String(index + 1)));
    let activeId = "4";
    const onSelect = vi.fn((nextId: string) => {
      activeId = nextId;
      void renderControlledStrip(container, tabs, { activeId, onSelect });
    });
    await renderControlledStrip(container, tabs, { activeId, onSelect });
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

    tabWithId(container, "8")?.click();
    await vi.waitFor(() => expect(activeId).toBe("8"));
    const lastActive = await expectControlledSelection(container, activeId);
    await expectOverflowTabVisible(container, lastActive);
  });

  it.each(["shared", "per-tab"])(
    "restores close focus with %s content targets",
    async (targets) => {
      const neighbor = host();
      await renderControlledStrip(
        neighbor,
        ["a", "b"].map((id) => Object.assign(tab(id), { domId: `neighbor-${id}` })),
        { ariaControls: "neighbor-panel" },
      );
      await expectControlledSelection(neighbor, "a");
      let container = host();
      const close = createDeferred();
      let tabs = [tab("a"), tab("b")];
      let activeId = "a";
      const onSelect = vi.fn();
      const ariaControls =
        targets === "shared"
          ? "browser-test-panel"
          : (entry: PanelTabStripTab) => `panel-${entry.id}`;
      const onClose = vi.fn((closedId: string) =>
        close.promise.then(async () => {
          (document.activeElement as HTMLElement | null)?.blur();
          tabs = tabs.filter((entry) => entry.id !== closedId);
          activeId = tabs[0]?.id ?? "";
          const replacement = document.createElement("div");
          mountedStrips.get(container)?.dispose();
          mountedStrips.delete(container);
          container.replaceWith(replacement);
          container = replacement;
          await update();
        }),
      );
      const update = () =>
        renderControlledStrip(container, tabs, { activeId, ariaControls, onSelect, onClose });
      await update();
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

      const fallback = await expectControlledSelection(container, activeId);
      await settleTabLayout();
      expect(document.activeElement).toBe(fallback);
    },
  );
});
