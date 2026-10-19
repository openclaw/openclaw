import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTabFocus } from "../lib/tabs.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  PanelTabStrip,
  type SolidPanelTabStripTab as PanelTabStripTab,
  type PanelTabStripProps,
} from "./panel-tab-strip-solid.tsx";
import { panelTabStripCss } from "./panel-tab-strip-styles.ts";

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

async function expectControlledSelection(root: ParentNode, id: string): Promise<RenderedTab> {
  flush();
  return vi.waitFor(() => {
    const tabs = renderedTabs(root);
    const active = tabs.find((entry) => entry.dataset.tabValue === id);
    const selected = tabs.filter((el) => el.matches('[active], [aria-selected="true"]'));
    expect(selected).toEqual([active]);
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

  it("controls activation and scrolls the selected tab into view", async () => {
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
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }),
    );
    await vi.waitFor(() => expect(activeId).toBe("5"));
    const arrowActive = await expectControlledSelection(container, activeId);
    expect(document.activeElement).toBe(arrowActive);

    renderedTabs(container)
      .find((entry) => entry.dataset.tabValue === "8")
      ?.click();
    await vi.waitFor(() => expect(activeId).toBe("8"));
    const lastActive = await expectControlledSelection(container, activeId);
    await settleTabLayout();
    const viewport = container.querySelector<HTMLElement>(".tabstrip")!;
    const bounds = viewport.getBoundingClientRect();
    const selected = lastActive.getBoundingClientRect();
    expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
    expect(selected.left).toBeGreaterThanOrEqual(bounds.left - 1);
    expect(selected.right).toBeLessThanOrEqual(bounds.right + 1);
  });

  it.each(["shared", "per-tab"])("restores close focus (%s targets)", async (targets) => {
    const neighbor = host();
    await renderControlledStrip(
      neighbor,
      ["a", "b"].map((id) => Object.assign(tab(id), { domId: `neighbor-${id}` })),
      { ariaControls: "neighbor-panel" },
    );
    await expectControlledSelection(neighbor, "a");
    let container = host();
    const focusOwner = createTabFocus();
    const close = createDeferred();
    let tabs = [tab("a"), tab("b")];
    const ariaControls =
      targets === "shared"
        ? "browser-test-panel"
        : (entry: PanelTabStripTab) => `panel-${entry.id}`;
    const onClose = vi.fn((closedId: string) =>
      close.promise.then(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        tabs = tabs.filter((entry) => entry.id !== closedId);
        const replacement = document.createElement("div");
        mountedStrips.get(container)?.dispose();
        mountedStrips.delete(container);
        container.replaceWith(replacement);
        container = replacement;
        await update();
      }),
    );
    const update = () =>
      renderControlledStrip(container, tabs, { ariaControls, onClose, focusOwner });
    await update();
    await expectControlledSelection(container, "a");
    expect(renderedTabs(container).map((entry) => entry.getAttribute("aria-controls"))).toEqual(
      targets === "shared" ? ["browser-test-panel", "browser-test-panel"] : ["panel-a", "panel-b"],
    );
    const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");
    closeButton?.focus();
    expect(document.activeElement).toBe(closeButton);

    closeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    closeButton?.blur();
    closeButton?.click();
    close.resolve();
    await close.promise;

    const fallback = await expectControlledSelection(container, "b");
    await settleTabLayout();
    expect(document.activeElement).toBe(fallback);
  });
});
