/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHubTabs } from "./hub-tabs.ts";

afterEach(() => document.body.replaceChildren());

describe("renderHubTabs", () => {
  it("renders counts, badges, and the reduced sub variant", () => {
    const container = document.createElement("div");
    render(
      renderHubTabs({
        id: "example",
        active: "files",
        tabs: [
          { value: "files", label: "Files", count: 3 },
          { value: "memory", label: "Memory", badge: "New" },
        ],
        ariaLabel: "Example sections",
        panelId: "example-panel",
        variant: "sub",
        onSelect: () => undefined,
      }),
      container,
    );
    expect(container.querySelector('[role="tablist"]')?.classList).toContain("hub-tabs--sub");
    expect(container.querySelector("#example-tab-files")?.hasAttribute("active")).toBe(true);
    expect(container.querySelector(".hub-tab__badge--count")?.textContent).toBe("3");
    expect(container.querySelector("#example-tab-memory .hub-tab__badge")?.textContent).toBe("New");
  });

  it("names the native tablist", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    try {
      render(
        renderHubTabs({
          id: "example",
          active: "files",
          tabs: [{ value: "files", label: "Files" }],
          ariaLabel: "Example sections",
          panelId: "example-panel",
          onSelect: () => undefined,
        }),
        container,
      );
      const group = container.querySelector<HTMLElement>('[role="tablist"]');
      await Promise.resolve();
      expect(group?.getAttribute("aria-label")).toBe("Example sections");
    } finally {
      container.remove();
    }
  });

  it.each([undefined, "first"] as const)(
    "selects only enabled tabs from direct activation with requested=%s",
    (requestedActive) => {
      const onSelect = vi.fn();
      const onActivate = vi.fn();
      const container = document.createElement("div");
      render(
        renderHubTabs({
          id: "example",
          active: "first",
          requestedActive,
          tabs: [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
            { value: "disabled", label: "Disabled", disabled: true },
          ],
          ariaLabel: "Example sections",
          panelId: "example-panel",
          onSelect,
          onActivate,
        }),
        container,
      );

      container
        .querySelector("#example-tab-second")
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      container
        .querySelector("#example-tab-disabled")
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

      container
        .querySelector("#example-tab-first")
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      for (const key of ["Enter", " "]) {
        container
          .querySelector("#example-tab-first")
          ?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }

      expect(onSelect).toHaveBeenCalledOnce();
      expect(onActivate).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledWith("second");
      expect(onActivate).toHaveBeenCalledWith(container.querySelector("#example-tab-second"));
      expect(container.querySelector("#example-tab-first")?.getAttribute("aria-selected")).toBe(
        "true",
      );
    },
  );

  it("preserves an intentional no-selection state", () => {
    const container = document.createElement("div");
    render(
      renderHubTabs({
        id: "example",
        active: null,
        tabs: [
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ],
        ariaLabel: "Example sections",
        panelId: "example-panel",
        onSelect: () => undefined,
      }),
      container,
    );

    expect(container.querySelector('[role="tab"][active]')).toBeNull();
    expect(container.querySelector<HTMLElement>("#example-tab-first")?.tabIndex).toBe(0);
    expect(container.querySelector<HTMLElement>("#example-tab-second")?.tabIndex).toBe(-1);
  });

  it.each([
    { dir: "ltr", next: "middle" },
    { dir: "rtl", next: "last" },
  ])("moves focus without activating routes in $dir", async ({ dir, next }) => {
    const container = document.createElement("div");
    container.dir = dir;
    document.body.append(container);
    const onSelect = vi.fn();
    render(
      renderHubTabs({
        id: "keyboard",
        active: "first",
        tabs: [
          { value: "first", label: "First" },
          { value: "middle", label: "Middle" },
          { value: "disabled", label: "Disabled", disabled: true },
          { value: "last", label: "Last" },
        ],
        ariaLabel: "Routes",
        panelId: "route-panel",
        onSelect,
      }),
      container,
    );
    await Promise.resolve();
    const first = container.querySelector<HTMLElement>("#keyboard-tab-first")!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement?.id).toBe(`keyboard-tab-${next}`);
    expect(onSelect).not.toHaveBeenCalled();
    expect(first.getAttribute("aria-selected")).toBe("true");
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    expect(document.activeElement?.id).toBe("keyboard-tab-last");
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(document.activeElement?.id).toBe(
      dir === "ltr" ? "keyboard-tab-middle" : "keyboard-tab-first",
    );
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("last");
  });
});
