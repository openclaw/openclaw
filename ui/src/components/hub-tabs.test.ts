/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid } from "../test-helpers/mount-solid.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { HubTabs, type HubTabsProps } from "./solid/hub-tabs.tsx";

const tabs = (...values: string[]) =>
  values.map((value) => ({
    value,
    label: value[0]!.toUpperCase() + value.slice(1),
    disabled: value === "disabled",
  }));

function mountTabs(props: Partial<HubTabsProps<string>>, dir = "ltr") {
  const container = document.body.appendChild(document.createElement("div"));
  container.dir = dir;
  mountSolid(
    HubTabs,
    {
      id: "example",
      active: "first",
      tabs: tabs("first", "second"),
      ariaLabel: "Example sections",
      panelId: "example-panel",
      onSelect: vi.fn(),
      ...props,
    },
    container,
  );
  return {
    tab: (value: string) =>
      container.querySelector<HTMLElement>(`#${props.id ?? "example"}-tab-${value}`)!,
    query: (selector: string) => container.querySelector(selector),
  };
}

function pressKey(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("HubTabs", () => {
  it("selects only enabled tabs from its named tablist", async () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    const { tab, query } = mountTabs({
      tabs: tabs("first", "second", "disabled"),
      onSelect,
      onActivate,
    });

    for (const value of ["second", "disabled", "first"]) {
      tab(value).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    }

    await Promise.resolve();
    expect(query('[role="tablist"]')?.getAttribute("aria-label")).toBe("Example sections");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("second");
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(tab("second"));
  });

  it("preserves an intentional no-selection state", () => {
    const { query, tab } = mountTabs({ active: null });
    expect(query('[role="tab"][active]')).toBeNull();
    expect([tab("first").tabIndex, tab("second").tabIndex]).toEqual([0, -1]);
  });

  it.each([
    { dir: "ltr", next: "middle" },
    { dir: "rtl", next: "last" },
  ])("moves focus without activating routes in $dir", async ({ dir, next }) => {
    const onSelect = vi.fn();
    const { tab } = mountTabs(
      {
        id: "keyboard",
        tabs: tabs("first", "middle", "disabled", "last"),
        onSelect,
      },
      dir,
    );
    await Promise.resolve();
    const first = tab("first");
    first.focus();
    pressKey(first, "ArrowRight");
    expect(document.activeElement?.id).toBe(`keyboard-tab-${next}`);
    expect(onSelect).not.toHaveBeenCalled();
    expect(first.getAttribute("aria-selected")).toBe("true");
    pressKey(document.activeElement!, "End");
    expect(document.activeElement?.id).toBe("keyboard-tab-last");
    pressKey(document.activeElement!, "ArrowLeft");
    expect(document.activeElement?.id).toBe(
      dir === "ltr" ? "keyboard-tab-middle" : "keyboard-tab-first",
    );
    pressKey(document.activeElement!, "End");
    pressKey(document.activeElement!, "Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("last");
  });
});
