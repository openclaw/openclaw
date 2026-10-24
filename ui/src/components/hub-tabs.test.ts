/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
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
    () =>
      createComponent(HubTabs, {
        id: "example",
        active: "first",
        tabs: tabs("first", "second"),
        ariaLabel: "Example sections",
        panelId: "example-panel",
        onSelect: vi.fn(),
        ...props,
      }),
    { container },
  );
  flush();
  return container;
}

function pressKey(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("HubTabs", () => {
  it("renders a named sub tablist with counts and badges", async () => {
    const container = mountTabs({
      active: "files",
      tabs: [
        { value: "files", label: "Files", count: 3 },
        { value: "memory", label: "Memory", badge: "New" },
      ],
      variant: "sub",
    });
    expect(container.querySelector('[role="tablist"]')?.classList).toContain("hub-tabs--sub");
    expect(container.querySelector("#example-tab-files")?.hasAttribute("active")).toBe(true);
    expect(container.querySelector(".hub-tab__badge--count")?.textContent).toBe("3");
    expect(container.querySelector("#example-tab-memory .hub-tab__badge")?.textContent).toBe("New");
    await Promise.resolve();
    expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(
      "Example sections",
    );
  });

  it("selects only enabled tabs from direct activation", () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    const container = mountTabs({
      tabs: tabs("first", "second", "disabled"),
      onSelect,
      onActivate,
    });

    for (const value of ["second", "disabled", "first"]) {
      container
        .querySelector(`#example-tab-${value}`)
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    }
    for (const value of ["Enter", " "]) {
      pressKey(container.querySelector("#example-tab-first")!, value);
    }

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("second");
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(
      container.querySelector("#example-tab-second"),
    );
    expect(container.querySelector("#example-tab-first")?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("preserves an intentional no-selection state", () => {
    const container = mountTabs({ active: null });

    expect(container.querySelector('[role="tab"][active]')).toBeNull();
    expect(container.querySelector<HTMLElement>("#example-tab-first")?.tabIndex).toBe(0);
    expect(container.querySelector<HTMLElement>("#example-tab-second")?.tabIndex).toBe(-1);
  });

  it.each([
    { dir: "ltr", next: "middle" },
    { dir: "rtl", next: "last" },
  ])("moves focus without activating routes in $dir", async ({ dir, next }) => {
    const onSelect = vi.fn();
    const container = mountTabs(
      {
        id: "keyboard",
        active: "first",
        tabs: tabs("first", "middle", "disabled", "last"),
        ariaLabel: "Routes",
        panelId: "route-panel",
        onSelect,
      },
      dir,
    );
    await Promise.resolve();
    const first = container.querySelector<HTMLElement>("#keyboard-tab-first")!;
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
