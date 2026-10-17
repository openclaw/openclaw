import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { Picker, type PickerParams, type PickerOption } from "./select-picker.ts";
import overlayStyles from "./solid/overlay.css?inline";

const options: PickerOption[] = [
  { value: "fixture/anchor", label: "Anchor", description: "Fixture provider" },
  { value: "fixture/aurora-large", label: "Aurora Large" },
  { value: "other/aurora-small", label: "Aurora Small", disabled: true },
  ...Array.from({ length: 6 }, (_, index) => ({
    value: `fixture/model-${index}`,
    label: `Model ${index}`,
  })),
];

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

async function mount(overrides: Partial<PickerParams<PickerOption>> = {}) {
  const params: PickerParams<PickerOption> = {
    label: "Model",
    value: "fixture/anchor",
    options,
    searchable: true,
    onChange: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const mountTarget = document.createElement("div");
  container.append(mountTarget);
  let setParams!: (next: PickerParams<PickerOption>) => void;
  mountSolid(
    () => {
      const [current, setCurrent] = createSignal({ ...params });
      setParams = setCurrent;
      return Picker({
        get params() {
          return current();
        },
      });
    },
    { container: mountTarget },
  );
  const picker = container.querySelector("openclaw-select-picker")!;
  const next = document.createElement("button");
  next.id = "next";
  next.textContent = "Next";
  container.append(next);
  const update = async (patch: Partial<PickerParams<PickerOption>>) => {
    Object.assign(params, patch);
    setParams({ ...params });
    flush();
    await picker.updateComplete;
  };
  await picker.updateComplete;
  const trigger = picker.querySelector<HTMLButtonElement>("button")!;
  const open = async () => {
    trigger.click();
    await picker.updateComplete;
  };
  const search = async (value: string) => {
    const input = picker.querySelector<HTMLInputElement>("input")!;
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await picker.updateComplete;
    return input;
  };
  const rows = () => [...picker.querySelectorAll<HTMLElement>('[role="option"]:not([hidden])')];
  const key = async (name: string, input: KeyboardEventInit = {}) => {
    const target = picker.querySelector<HTMLElement>("[data-picker-focus]") ?? trigger;
    const event = new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...input,
    });
    target.dispatchEvent(event);
    await picker.updateComplete;
    return event;
  };
  return { params, picker, trigger, open, search, rows, key, update, container };
}

describe("Picker", () => {
  it("keeps closed choices unmounted across catalog refreshes and shows current choices on open", async () => {
    const p = await mount({ searchable: false });
    const menu = p.picker.querySelector<HTMLElement>(".picker-select__menu")!;
    expect(p.rows()).toHaveLength(0);
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(menu, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    try {
      await p.update({
        options: [{ value: "updated", label: "Updated choice" }],
        value: "updated",
      });
      mutations.push(...observer.takeRecords());
      expect(mutations).toHaveLength(0);
      expect(p.trigger.getAttribute("aria-label")).toBe("Model: Updated choice");
      await p.key("ArrowDown");
      expect(p.rows().map((row) => row.textContent?.trim())).toEqual(["Updated choice"]);
      expect(document.activeElement).toBe(p.picker.querySelector(".picker-select__options"));
      await p.key("Escape");
      expect(p.rows()).toHaveLength(0);
      await p.update({ options, value: "fixture/anchor" });
      expect(p.rows()).toHaveLength(0);
      await p.open();
      expect(p.rows()).toHaveLength(options.length);
      expect(p.params.onChange).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
  });

  it("keeps grouped choices clickable near the viewport edge when overlay styles load later", async () => {
    const { page } = await import("vitest/browser");
    const initialViewport = { width: innerWidth, height: innerHeight };
    try {
      await page.viewport(1280, 1000);
      const lateOverlayStyles = document.createElement("style");
      lateOverlayStyles.textContent = overlayStyles;
      document.body.append(lateOverlayStyles);
      const p = await mount({
        value: "inherited",
        options: [
          { value: "inherited", label: "Use global default" },
          { value: "", label: "Disabled" },
          { value: "fixture/one", label: "One" },
          { value: "fixture/two", label: "Two" },
        ],
        groupBy: (option) =>
          option.value.startsWith("fixture/") ? { id: "fixture", label: "Fixture" } : undefined,
        searchable: "always",
      });
      p.container.style.cssText = "position:fixed;right:12px;top:calc(100vh - 50px);width:240px";
      expect(
        p.picker
          .querySelector<HTMLElement>(".picker-select__menu")!
          .style.getPropertyValue("position-anchor"),
      ).toBe(p.trigger.style.getPropertyValue("anchor-name"));
      await page.elementLocator(p.trigger).click();
      const row = p.picker.querySelector<HTMLElement>('[role="option"][data-value=""]')!;
      const menu = p.picker.querySelector<HTMLElement>(".picker-select__menu")!;
      const bounds = menu.getBoundingClientRect();
      const optionBounds = row.getBoundingClientRect();
      expect(optionBounds.top).toBeGreaterThanOrEqual(bounds.top);
      expect(optionBounds.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
      await page.elementLocator(row).click();
      expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("");
    } finally {
      await page.viewport(initialViewport.width, initialViewport.height);
    }
  });

  it("keeps reserved option values distinct from the popup and trigger IDs", async () => {
    const p = await mount({
      value: "content",
      options: [
        { value: "content", label: "Content" },
        { value: "trigger", label: "Trigger" },
      ],
      searchable: "always",
    });
    await p.open();
    const search = p.picker.querySelector<HTMLInputElement>("input")!;
    for (const value of ["content", "trigger"]) {
      const row = p.rows().find((option) => option.dataset.value === value)!;
      await expect.element(search).toHaveAttribute("aria-activedescendant", row.id);
      const active = document.getElementById(search.getAttribute("aria-activedescendant")!);
      expect(active?.getAttribute("role")).toBe("option");
      expect(active?.dataset.value).toBe(value);
      const ids = [...p.picker.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
      if (value === "content") {
        await p.key("ArrowDown");
      }
    }
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("trigger");
  });

  it.each([false, true])(
    "does not rewrite retained choices when search removes preceding rows (grouped=%s)",
    async (grouped) => {
      const choices = [
        { value: "other", label: "Other choice" },
        ...Array.from({ length: 8 }, (_, index) => ({
          value: "atlas-" + index,
          label: "Atlas " + index,
        })),
      ];
      const p = await mount({
        options: choices,
        value: "atlas-0",
        groupBy: grouped ? () => ({ id: "models", label: "Models" }) : undefined,
      });
      await p.open();
      const retained = p.rows().find((row) => row.dataset.value === "atlas-3")!;
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) => mutations.push(...records));
      if (!grouped) {
        observer.observe(p.picker.querySelector(".picker-select__options")!, { childList: true });
      }
      observer.observe(retained, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      try {
        await p.search("atlas");
        mutations.push(...observer.takeRecords());
        expect(p.rows().map((row) => row.dataset.value)).toEqual(
          choices.slice(1).map((option) => option.value),
        );
        expect(mutations).toHaveLength(0);
        expect(retained.isConnected).toBe(true);
        const input = p.picker.querySelector("input")!;
        expect(
          document.getElementById(input.getAttribute("aria-activedescendant")!)?.dataset.value,
        ).toBe("atlas-0");
        expect(p.params.onChange).not.toHaveBeenCalled();
      } finally {
        observer.disconnect();
      }
    },
  );

  it("leaves closed-trigger Escape to the page after dismissing the menu without a write", async () => {
    const p = await mount();
    const pageKey = vi.fn();
    p.container.addEventListener("keydown", pageKey);
    p.trigger.focus();
    p.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pageKey).toHaveBeenCalledOnce();
    pageKey.mockClear();
    await p.open();
    await p.key("Escape");
    expect(pageKey).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(p.trigger);
    p.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pageKey).toHaveBeenCalledOnce();
    expect(p.params.onChange).not.toHaveBeenCalled();
  });

  it("names the field and current selection when the closed trigger receives focus", async () => {
    const p = await mount();
    p.trigger.focus();
    expect(p.trigger.getAttribute("aria-label")).toBe("Model: Anchor");
    await p.update({ value: "fixture/aurora-large" });
    expect(p.trigger.getAttribute("aria-label")).toBe("Model: Aurora Large");
    expect(p.params.onChange).not.toHaveBeenCalled();
  });

  it("retains the current short-menu choice when typeahead has no match", async () => {
    const p = await mount({
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
      value: "beta",
    });
    await p.open();
    await p.key("z");
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it.each([
    { value: "beta", disabled: false, expected: "beta" },
    { value: "", disabled: false, expected: "" },
    { value: "beta", disabled: true, expected: "gamma" },
    { value: null, disabled: false, expected: "gamma" },
  ])(
    "opens with ArrowUp at the enabled selection or last fallback (value=$value, disabled=$disabled)",
    async ({ value, disabled, expected }) => {
      const { userEvent } = await import("vitest/browser");
      const p = await mount({
        value,
        options: [
          { value: "", label: "Automatic" },
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta", disabled },
          { value: "gamma", label: "Gamma" },
        ],
      });
      p.trigger.focus();
      await userEvent.keyboard("{ArrowUp}");
      await expect.element(p.trigger).toHaveAttribute("aria-expanded", "true");
      expect(p.params.onChange).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith(expected);
    },
  );

  it("opens a compact menu with a printable key without committing it", async () => {
    const p = await mount({
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
      value: "beta",
    });
    await p.key("a");
    expect(p.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("uses spaces and backspace for compact-menu typeahead without an early commit", async () => {
    const p = await mount({
      options: [
        { value: "cat", label: "Big Cat" },
        { value: "dog", label: "Big Dog" },
      ],
      value: "cat",
    });
    await p.open();
    for (const key of ["b", "i", "g", " ", "c", "Backspace", "d"]) {
      await p.key(key);
    }
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("dog");
  });

  it("filters label and exact reference substrings without changing the selected value", async () => {
    const p = await mount();
    await p.open();
    const filteredOut = p.rows()[0]!;
    await p.search("AURORA");
    filteredOut.click();
    expect(p.rows().map((row) => row.dataset.value)).toEqual([
      "fixture/aurora-large",
      "other/aurora-small",
    ]);
    await p.search("TURE/AURORA-L");
    expect(p.rows().map((row) => row.dataset.value)).toEqual(["fixture/aurora-large"]);
    expect(p.trigger.textContent).toContain("Anchor");
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.search("");
    expect(p.rows()).toHaveLength(9);
    expect(p.rows()[0]?.textContent).toContain("Fixture provider");
    await p.key("Escape");
    expect(document.activeElement).toBe(p.trigger);
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.open();
    expect(p.picker.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(p.rows()).toHaveLength(9);
  });

  it("commits an enabled visible choice once and skips disabled keyboard rows", async () => {
    const p = await mount();
    await p.open();
    await p.search("aurora");
    await p.key("ArrowDown");
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("fixture/aurora-large");
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not select disabled rows or a row removed by a catalog refresh", async () => {
    const p = await mount();
    await p.open();
    const [, removed, disabled] = p.rows();
    if (!removed || !disabled) {
      throw new Error("Expected enabled and disabled model rows");
    }
    disabled.click();
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.search("aurora");
    await p.update({
      options: options.filter((option) => option.value !== "fixture/aurora-large"),
    });
    expect(p.picker.querySelector<HTMLInputElement>("input")!.value).toBe("aurora");
    removed.click();
    await p.key("Enter");
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.key("Escape");
    await p.open();
    expect(p.picker.querySelector("input")).toBeNull();
    expect(p.rows()).toHaveLength(8);
  });

  it("announces no matches and leaves composition and text editing keys alone", async () => {
    const p = await mount();
    await p.open();
    await p.search("not-present");
    expect(p.rows()).toHaveLength(0);
    expect(p.picker.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(false);
    expect(p.picker.querySelector('[role="status"]')!.textContent?.trim()).toBe("No matches");
    expect((await p.key(" ")).defaultPrevented).toBe(false);
    expect((await p.key("Home")).defaultPrevented).toBe(false);
    expect((await p.key("Enter", { isComposing: true })).defaultPrevented).toBe(false);
    expect(p.params.onChange).not.toHaveBeenCalled();
    const shortcut = vi.fn();
    p.container.addEventListener("keydown", shortcut);
    await p.key("x");
    expect(shortcut).not.toHaveBeenCalled();
  });

  it("keeps short menus compact, supports typeahead, and retains empty/unknown values", async () => {
    const p = await mount({
      value: "retired/model",
      options: [
        { value: "", label: "Automatic" },
        { value: "new/model", label: "New model" },
      ],
    });
    await p.key("ArrowDown");
    expect(p.picker.querySelector("input")).toBeNull();
    expect(p.trigger.textContent).toContain("retired/model");
    await p.key("a");
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("does not write on outside dismissal, disables an open picker, and closes on disconnect", async () => {
    const p = await mount();
    await p.open();
    await p.search("aurora");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await p.picker.updateComplete;
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
    await p.open();
    await p.update({ disabled: true });
    expect(p.trigger.disabled).toBe(true);
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(p.params.onChange).not.toHaveBeenCalled();
    p.picker.remove();
    p.container.append(p.picker);
    await p.picker.updateComplete;
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("retains label styles, tooltips, and open effects", async () => {
    const onOpen = vi.fn();
    const p = await mount({
      options: [
        { value: "plain", label: "Plain" },
        { value: "styled", label: "Styled", labelStyle: "font-family: Georgia" },
      ],
      value: "plain",
      onOpen,
    });
    expect(onOpen).not.toHaveBeenCalled();
    await p.open();
    const labels = p.rows().map((row) => row.querySelector<HTMLElement>(".picker-select__label")!);
    expect(p.rows().map((row) => row.getAttribute("title"))).toEqual(["plain", "styled"]);
    expect(labels[0]?.hasAttribute("style")).toBe(false);
    expect(labels[1]?.style.fontFamily).toBe("Georgia");
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
