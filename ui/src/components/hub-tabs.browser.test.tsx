import type { JSX } from "@solidjs/web";
import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { HubTabs, type HubTabsProps } from "./solid/hub-tabs.tsx";
import "../styles/base.css";
import "../styles/agents.css";

const tabDefaults: HubTabsProps<string> = {
  id: "agent-files",
  active: "agents",
  panelId: "bounded-panel",
  ariaLabel: "Activity view",
  tabs: ["agents", "heartbeat", "identity"].map((value) => ({
    value,
    label: value.toUpperCase(),
    badge: value === "agents" ? undefined : "Missing",
  })),
  onSelect: () => {},
};

async function mountTabs(
  cssText: string,
  props: Partial<HubTabsProps<string>>,
  extra: JSX.Element,
  className = "",
) {
  const { container: root } = mountSolid(() => [<HubTabs {...tabDefaults} {...props} />, extra]);
  root.className = className;
  root.style.cssText = cssText;
  await waitForSolid(() => expect(root.querySelector("[role=tablist]")).not.toBeNull());
  return { root, tabs: root.querySelector<HTMLElement>("[role=tablist]")! };
}

it.each(["primary", "sub"] as const)(
  "keeps %s tabs at natural height above a flexing panel",
  async (variant) => {
    const { root, tabs } = await mountTabs(
      "display:flex;flex-direction:column;width:240px",
      { variant },
      <div id="bounded-panel" style={{ flex: "1 1 auto", "min-height": "0" }}>
        <div style={{ height: "600px" }}>Activity content</div>
      </div>,
    );
    const naturalHeight = tabs.getBoundingClientRect().height;
    expect(naturalHeight).toBeGreaterThan(24);

    root.style.height = "180px";
    expect(tabs.getBoundingClientRect().height).toBe(naturalHeight);
    const panel = root.querySelector("#bounded-panel")!.getBoundingClientRect();
    expect(panel.bottom).toBeLessThanOrEqual(root.getBoundingClientRect().bottom);
  },
);

it("shrinks row tabs to fit Add File", async () => {
  const { root, tabs } = await mountTabs(
    "width:280px",
    { variant: "sub" },
    <select class="agent-tab-add" aria-label="Add File">
      <option>Add File</option>
      <option>MEMORY</option>
    </select>,
    "agent-file-tabs",
  );
  const control = root.querySelector("select")!;
  const panelBounds = root.getBoundingClientRect();
  const tabBounds = tabs.getBoundingClientRect();
  const controlBounds = control.getBoundingClientRect();
  expect(tabBounds.right).toBeLessThanOrEqual(controlBounds.left);
  expect(controlBounds.right).toBeLessThanOrEqual(panelBounds.right);
  expect(tabBounds.width).toBeLessThan(panelBounds.width);
  expect(tabs.scrollWidth).toBeGreaterThan(tabs.clientWidth);
});
