import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  PanelTabStrip,
  type SolidPanelTabStripTab as PanelTabStripTab,
  type PanelTabStripProps,
} from "./panel-tab-strip-solid.tsx";
import { panelTabStripCss } from "./panel-tab-strip-styles.ts";
import sidePanelStyles from "../styles/chat/side-panel.css?inline";

type RenderedTab = HTMLButtonElement;
type StripProps = PanelTabStripProps<PanelTabStripTab>;
type MountedStrip = { update: (props: StripProps) => void; dispose: () => void };
const host = () => document.body.appendChild(document.createElement("div"));
const mountedStrips = new Map<HTMLElement | DocumentFragment, MountedStrip>();

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

const tab = (id: string): PanelTabStripTab => ({
  id,
  domId: `browser-test-tab-${id}`,
  label: `Tab ${id.toUpperCase()}`,
  closeLabel: `Close tab ${id.toUpperCase()}`,
});

async function renderControlledStrip(
  container: HTMLElement | DocumentFragment,
  tabs: PanelTabStripTab[],
  options: Partial<StripProps> = {},
) {
  const props: StripProps = {
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

const renderedTabs = (root: ParentNode) => [...root.querySelectorAll<RenderedTab>(".tabstrip-tab")];

async function settleTabLayout() {
  flush();
  await new Promise(requestAnimationFrame);
}

async function expectOverflowTabVisible(container: ParentNode, selectedTab: HTMLElement) {
  await settleTabLayout();
  const viewport = container.querySelector<HTMLElement>(".tabstrip");
  if (!viewport) {
    throw new Error("expected rendered tab strip viewport");
  }
  const viewportRect = viewport.getBoundingClientRect();
  const tabRect = selectedTab.getBoundingClientRect();
  const closeRect = selectedTab.nextElementSibling!.getBoundingClientRect();
  expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
  expect(tabRect.left).toBeGreaterThanOrEqual(viewportRect.left - 1);
  expect(tabRect.right).toBeLessThanOrEqual(viewportRect.right + 1);
  expect(closeRect.left).toBeGreaterThanOrEqual(viewportRect.left - 1);
  expect(closeRect.right).toBeLessThanOrEqual(viewportRect.right + 1);
}

async function expectControlledSelection(root: ParentNode, id: string): Promise<RenderedTab> {
  flush();
  return vi.waitFor(() => {
    const tabs = renderedTabs(root);
    const active = tabs.find((entry) => entry.dataset.tabValue === id);
    expect(tabs.filter((el) => el.matches('[active], [aria-selected="true"]'))).toEqual([active]);
    expect(tabs.map((entry) => entry.tabIndex)).toEqual(
      tabs.map((entry) => (entry === active ? 0 : -1)),
    );
    return active!;
  });
}

afterEach(() => {
  mountedStrips.forEach(({ dispose }) => dispose());
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

  it.each([
    { surface: "standalone", direction: "ltr" },
    { surface: "sidebar", direction: "ltr" },
    { surface: "sidebar", direction: "rtl" },
  ])(
    "keeps the active tab and its close action visible in $surface $direction overflow",
    async ({ surface, direction }) => {
      const style = document.createElement("style");
      style.id = "panel-tab-strip-browser-test-styles";
      style.textContent = `${panelTabStripCss}\n${sidePanelStyles}`;
      document.head.append(style);
      const scrollPort = host();
      scrollPort.style.cssText = "height: 80px; width: 240px; overflow: auto";
      const before = document.createElement("div");
      before.style.height = "64px";
      const after = document.createElement("div");
      after.style.height = "120px";
      const container = document.createElement("div");
      scrollPort.append(before, container, after);
      container.className = surface === "sidebar" ? "side-panel__header" : "";
      container.dir = direction;
      container.style.width = "220px";
      const tabs = Array.from({ length: 8 }, (_, index) => tab(String(index + 1)));
      let activeId = "4";
      const onSelect = vi.fn((nextId: string) => {
        activeId = nextId;
        void renderControlledStrip(container, tabs, { activeId, onSelect });
      });
      await renderControlledStrip(container, tabs, { activeId, onSelect });
      const initialActive = await expectControlledSelection(container, activeId);
      initialActive.focus({ preventScroll: true });
      await settleTabLayout();
      scrollPort.scrollTop =
        initialActive.getBoundingClientRect().top - scrollPort.getBoundingClientRect().top + 8;
      const ancestorScrollTop = scrollPort.scrollTop;
      const scrollY = window.scrollY;
      expect(initialActive.getBoundingClientRect().top).toBeLessThan(
        scrollPort.getBoundingClientRect().top,
      );
      expect(initialActive.getBoundingClientRect().bottom).toBeGreaterThan(
        scrollPort.getBoundingClientRect().top,
      );
      let keyboardActive = initialActive;
      for (const [key, selectedId] of [
        [direction === "rtl" ? "ArrowLeft" : "ArrowRight", "5"],
        ["End", "8"],
        ["Home", "1"],
      ]) {
        keyboardActive.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, composed: true }),
        );
        await vi.waitFor(() => expect(activeId).toBe(selectedId));
        keyboardActive = await expectControlledSelection(container, activeId);
        expect(document.activeElement).toBe(keyboardActive);
        await expectOverflowTabVisible(container, keyboardActive);
        expect(scrollPort.scrollTop).toBe(ancestorScrollTop);
        expect(window.scrollY).toBe(scrollY);
      }

      for (const id of ["8", "1"]) {
        renderedTabs(container)
          .find((entry) => entry.dataset.tabValue === id)
          ?.click();
        await vi.waitFor(() => expect(activeId).toBe(id));
        await expectOverflowTabVisible(container, await expectControlledSelection(container, id));
        expect(document.activeElement).toBe(keyboardActive);
        expect(scrollPort.scrollTop).toBe(ancestorScrollTop);
        expect(window.scrollY).toBe(scrollY);
      }
    },
  );

  it("restores keyboard-close focus after blur without selecting a neighboring strip", async () => {
    const neighbor = host();
    await renderControlledStrip(
      neighbor,
      ["a", "b"].map((id) => Object.assign(tab(id), { domId: `neighbor-${id}` })),
      { ariaControls: "neighbor-panel" },
    );
    await expectControlledSelection(neighbor, "a");
    expect(renderedTabs(neighbor)[0]?.getAttribute("aria-controls")).toBe("neighbor-panel");
    const container = host();
    let tabs = [tab("a"), tab("b")];
    const ariaControls = (entry: PanelTabStripTab) => `panel-${entry.id}`;
    const onClose = (closedId: string) => {
      tabs = tabs.filter((entry) => entry.id !== closedId);
      return renderControlledStrip(container, tabs, { ariaControls, onClose });
    };
    await renderControlledStrip(container, tabs, { ariaControls, onClose });
    await expectControlledSelection(container, "a");
    expect(renderedTabs(container).map((entry) => entry.getAttribute("aria-controls"))).toEqual([
      "panel-a",
      "panel-b",
    ]);
    const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");
    closeButton?.focus();
    expect(document.activeElement).toBe(closeButton);

    closeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    closeButton?.blur();
    closeButton?.click();
    const fallback = await expectControlledSelection(container, "b");
    await settleTabLayout();
    expect(document.activeElement).toBe(fallback);
  });
});
