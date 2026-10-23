import type { JSX } from "@solidjs/web";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { HubTabs, type HubTabsProps } from "./solid/hub-tabs.tsx";
import "../styles/base.css";
import "../styles/agents.css";

function makeRoot(cssText = "", className = "") {
  const root = document.body.appendChild(document.createElement("div"));
  Object.assign(root, { className });
  root.style.cssText = cssText;
  onTestFinished(() => root.remove());
  return root;
}

const tabDefaults: HubTabsProps<string> = {
  id: "bounded",
  active: "sessions",
  panelId: "bounded-panel",
  ariaLabel: "Activity view",
  tabs: [
    { value: "sessions", label: "Sessions" },
    { value: "live", label: "Live activity" },
  ],
  onSelect: () => {},
};

type TabProps = Partial<HubTabsProps<string>>;
async function mountTabs(root: HTMLElement, props: TabProps, extra?: JSX.Element) {
  const view = mountSolid(() => [<HubTabs {...tabDefaults} {...props} />, extra], {
    container: root,
  });
  await waitForSolid(() => expect(root.querySelector("[role=tablist]")).not.toBeNull());
  return { ...view, tabs: root.querySelector<HTMLElement>("[role=tablist]")! };
}

it.each(["primary", "sub"] as const)(
  "keeps %s tabs at natural height above a flexing panel",
  async (variant) => {
    const root = makeRoot("display:flex;flex-direction:column;width:240px");
    const { tabs } = await mountTabs(
      root,
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
  const root = makeRoot("width:280px", "agent-file-tabs");
  const { tabs } = await mountTabs(
    root,
    {
      id: "agent-files",
      active: "agents",
      variant: "sub",
      tabs: ["agents", "heartbeat", "identity"].map((value) => ({
        value,
        label: value.toUpperCase(),
        badge: value === "agents" ? undefined : "Missing",
      })),
    },
    <select class="agent-tab-add" aria-label="Add File">
      <option>Add File</option>
      <option>MEMORY</option>
    </select>,
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

it("restores keyboard focus across tab-strip replacement", async () => {
  const root = makeRoot();
  const onSelect = vi.fn();
  const source = await mountTabs(root, { onSelect });
  const target = root.querySelector<HTMLElement>("#bounded-tab-live")!;
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSelect).toHaveBeenCalledWith("live");

  source.unmount();
  await mountTabs(root, { onSelect, active: "live" });
  await expect.poll(() => document.activeElement?.id).toBe("bounded-tab-live");
});
