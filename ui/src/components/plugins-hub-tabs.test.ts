/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderPluginsHubTabs, type PluginsHubTabsProps } from "./plugins-hub-tabs.ts";

function mount(props: PluginsHubTabsProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPluginsHubTabs(props), container);
  return container;
}

describe("renderPluginsHubTabs", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders all hub tabs with the active tab selected", () => {
    const container = mount({ active: "skills", installedCount: 4, onSelect: () => undefined });
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.id)).toEqual([
      "plugins-tab-installed",
      "plugins-tab-discover",
      "plugins-tab-skills",
      "plugins-tab-workshop",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(container.querySelector("#plugins-tab-installed")?.textContent).toContain("4");
  });

  it("omits the installed count badge when no catalog data is provided", () => {
    const container = mount({ active: "workshop", onSelect: () => undefined });
    expect(container.querySelector("#plugins-tab-installed span")).toBeNull();
  });

  it("selects tabs on click", () => {
    const onSelect = vi.fn();
    const container = mount({ active: "installed", onSelect });
    container.querySelector<HTMLButtonElement>("#plugins-tab-workshop")?.click();
    expect(onSelect).toHaveBeenLastCalledWith("workshop");
  });

  it("uses roving focus and arrow-key activation across all hub tabs", () => {
    const onSelect = vi.fn();
    const container = mount({ active: "installed", onSelect });
    const installed = container.querySelector<HTMLButtonElement>("#plugins-tab-installed")!;
    const discover = container.querySelector<HTMLButtonElement>("#plugins-tab-discover")!;
    const workshop = container.querySelector<HTMLButtonElement>("#plugins-tab-workshop")!;

    expect([installed.tabIndex, discover.tabIndex]).toEqual([0, -1]);
    installed.focus();
    installed.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith("discover");
    expect(document.activeElement).toBe(discover);

    discover.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith("workshop");
    expect(document.activeElement).toBe(workshop);

    workshop.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith("installed");
    expect(document.activeElement).toBe(installed);
  });
});
