/* @vitest-environment jsdom */

import { createComponent, createSignal, flush } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import { PanelTabStrip } from "../../components/panel-tab-strip-solid.tsx";
import { Tabs, type TabsProps } from "../../components/solid/tabs.tsx";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import tabsStyles from "../../styles/tabs.css?inline";

const items = [
  { value: "first", label: "First" },
  { value: "second", label: "Second" },
];

function shadowRoot() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = host.attachShadow({ mode: "open" });
  onTestFinished(() => host.remove());
  return root;
}

function createTabsFixture(root?: ShadowRoot, props: () => Partial<TabsProps> = () => ({})) {
  return mountSolid(() => <Tabs items={items} active={null} ariaLabel="Sections" {...props()} />, {
    container: root?.appendChild(document.createElement("div")),
  });
}

function styles(root: ParentNode) {
  const sheets = root.querySelectorAll("style[data-openclaw-overlay-style]");
  return Array.from(sheets, (style) => style.textContent);
}

it("shares tab styles across components and releases them with the last consumer", () => {
  const root = shadowRoot();
  const tabs = createTabsFixture(root);
  const panel = mountSolid(
    () =>
      createComponent(PanelTabStrip, {
        tabs: [{ id: "first", domId: "tab-first", label: "First", closeLabel: "Close first" }],
        activeId: "first",
        ariaControls: "panel",
        newLabel: "New tab",
        onSelect() {},
        onClose() {},
        onNew() {},
      }),
    { container: root.appendChild(document.createElement("div")) },
  );
  flush();
  expect(styles(root)).toEqual([tabsStyles]);

  panel.unmount();
  expect(styles(root)).toEqual([tabsStyles]);
  tabs.unmount();
  expect(styles(root)).toEqual([]);
});

it.each(["items", "active"] as const)(
  "refreshes a moved tablist's shadow root when %s changes",
  (changed) => {
    const original = shadowRoot();
    const destination = shadowRoot();
    const [currentItems, setItems] = createSignal(items);
    const [active, setActive] = createSignal("first");
    const view = mountSolid(
      () => <Tabs items={currentItems()} active={active()} ariaLabel="Sections" />,
      { container: original.appendChild(document.createElement("div")) },
    );
    flush();
    expect(styles(original)).toEqual([tabsStyles]);

    destination.append(view.container);
    if (changed === "items") {
      setItems([...items, { value: "third", label: "Third" }]);
    } else {
      setActive("second");
    }
    flush();
    expect(styles(original)).toEqual([]);
    expect(styles(destination)).toEqual([tabsStyles]);

    view.unmount();
    expect(styles(destination)).toEqual([]);
  },
);

it("replaces extra shadow styles without adding them to light DOM", () => {
  const root = shadowRoot();
  const firstStyle = ".first { color: red; }";
  const secondStyle = ".second { color: blue; }";
  const [extra, setExtra] = createSignal([firstStyle]);
  const props = () => ({ shadowStyles: extra() });
  const shadow = createTabsFixture(root, props);
  const documentStyles = styles(document);
  const light = createTabsFixture(undefined, props);
  flush();
  expect(styles(root)).toEqual([tabsStyles, firstStyle]);
  expect(styles(document)).toEqual(documentStyles);

  setExtra([secondStyle]);
  flush();
  expect(styles(root)).toEqual([tabsStyles, secondStyle]);
  expect(styles(document)).toEqual(documentStyles);

  light.unmount();
  shadow.unmount();
  expect(styles(root)).toEqual([]);
});
