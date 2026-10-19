/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { PanelTabStrip } from "../../components/panel-tab-strip-solid.tsx";
import { Tabs } from "../../components/solid/tabs.tsx";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import tabsStyles from "../../styles/tabs.css?inline";

const items = [
  { value: "first", label: "First" },
  { value: "second", label: "Second" },
];

function shadowContainer() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  root.append(container);
  onTestFinished(() => host.remove());
  return { root, container };
}

function styles(root: ParentNode) {
  return [...root.querySelectorAll("style[data-openclaw-overlay-style]")].map(
    (style) => style.textContent,
  );
}

afterEach(cleanupSolid);

it("shares tab styles across components and releases them with the last consumer", () => {
  const { root, container } = shadowContainer();
  const panelContainer = document.createElement("div");
  root.append(panelContainer);
  const tabs = mountSolid(() => <Tabs items={items} ariaLabel="Sections" />, { container });
  const panel = mountSolid(
    () => (
      <PanelTabStrip
        tabs={[{ id: "first", domId: "tab-first", label: "First", closeLabel: "Close first" }]}
        activeId="first"
        ariaControls="panel"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        newLabel="New tab"
      />
    ),
    { container: panelContainer },
  );
  flush();
  expect(styles(root)).toEqual([tabsStyles]);

  panel.unmount();
  expect(styles(root)).toEqual([tabsStyles]);
  tabs.unmount();
  expect(styles(root)).toEqual([]);
});

it.each(["items", "active", "defaultActive"] as const)(
  "refreshes a moved tablist's shadow root when %s changes",
  (changed) => {
    const original = shadowContainer();
    const destination = shadowContainer();
    const [currentItems, setItems] = createSignal(items);
    const [active, setActive] = createSignal("first");
    const [defaultActive, setDefaultActive] = createSignal("first");
    const view = mountSolid(
      () => (
        <Tabs
          items={currentItems()}
          active={active()}
          defaultActive={defaultActive()}
          ariaLabel="Sections"
        />
      ),
      { container: original.container },
    );
    flush();
    expect(styles(original.root)).toEqual([tabsStyles]);

    destination.root.append(view.container);
    if (changed === "items") {
      setItems([...items, { value: "third", label: "Third" }]);
    } else if (changed === "active") {
      setActive("second");
    } else {
      setDefaultActive("second");
    }
    flush();
    expect(styles(original.root)).toEqual([]);
    expect(styles(destination.root)).toEqual([tabsStyles]);

    view.unmount();
    expect(styles(destination.root)).toEqual([]);
  },
);

it("replaces extra shadow styles without adding them to light DOM", () => {
  const { root, container } = shadowContainer();
  const firstStyle = ".first { color: red; }";
  const secondStyle = ".second { color: blue; }";
  const [extra, setExtra] = createSignal([firstStyle]);
  const shadow = mountSolid(
    () => <Tabs items={items} ariaLabel="Shadow sections" shadowStyles={extra()} />,
    { container },
  );
  const documentStyles = styles(document);
  const light = mountSolid(() => (
    <Tabs items={items} ariaLabel="Light sections" shadowStyles={extra()} />
  ));
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
