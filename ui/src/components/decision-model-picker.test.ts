import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { choosePickerValue, updatePickers } from "../test-helpers/select-picker.ts";
import { renderDecisionModelPicker, type DecisionModelEntry } from "./decision-model-picker.ts";
import type { SelectPicker } from "./select-picker.ts";

const models: DecisionModelEntry[] = [
  { provider: "alpha", id: "last", name: "Zulu", pluginId: "alpha" },
  { provider: "beta", id: "middle", name: "Middle", pluginId: "beta" },
  { provider: "alpha", id: "first", name: "First", pluginId: "alpha" },
];
afterEach(() => document.body.replaceChildren());

async function mount(overrides: Partial<Parameters<typeof renderDecisionModelPicker>[0]> = {}) {
  const container = document.createElement("div");
  const params = {
    id: "decision",
    models,
    value: "alpha/first",
    disabled: false,
    onChange: vi.fn(),
    ...overrides,
  };
  const update = async (patch: Partial<typeof params> = {}) => {
    Object.assign(params, patch);
    render(renderDecisionModelPicker({ ...params }), container);
    await updatePickers(container);
  };
  await update();
  const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
  const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
  trigger.click();
  await picker.updateComplete;
  const rows = () => [...picker.querySelectorAll<HTMLElement>('[role="option"]')];
  const search = async (value: string) => {
    const input = picker.querySelector<HTMLInputElement>("input")!;
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await picker.updateComplete;
    return input;
  };
  const key = async (value: string, target: HTMLElement = picker.querySelector("input")!) => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    await picker.updateComplete;
    return event;
  };
  const group = (label: string) =>
    picker.querySelector<HTMLElement>('[role="group"][aria-label="' + label + '"]')!;
  const toggle = async (label: string) => {
    group(label).querySelector<HTMLButtonElement>("button")!.click();
    await picker.updateComplete;
  };
  return { params, picker, trigger, update, rows, search, key, group, toggle };
}

describe("decision model provider groups", () => {
  it("groups interleaved model names and traverses the rendered order, leaving Disabled ungrouped", async () => {
    const p = await mount();
    expect(
      [...p.picker.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Alpha", "Beta"]);
    expect(p.rows().map((r) => r.dataset.value)).toEqual([
      "",
      "alpha/first",
      "alpha/last",
      "beta/middle",
    ]);
    expect(p.rows()[0]!.closest('[role="group"]')).toBeNull();
    expect(p.group("Alpha").querySelector("button")!.textContent).toContain("2");
    expect(p.group("Alpha").querySelector(".provider-brand-icon--fallback")).not.toBeNull();
    expect(p.picker.querySelector("input")!.getAttribute("placeholder")).toBe("Search models");
    await p.key("ArrowDown");
    const input = p.picker.querySelector("input")!;
    expect(
      document.getElementById(input.getAttribute("aria-activedescendant")!)?.dataset.value,
    ).toBe("alpha/last");
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("alpha/last");
  });

  it("excludes collapsed rows from keyboard and stale pointer selection but searches inside them", async () => {
    const p = await mount({ value: "" });
    const stale = p.rows().find((r) => r.dataset.value === "alpha/first")!;
    await p.toggle("Alpha");
    stale.click();
    await p.picker.updateComplete;
    expect(p.params.onChange).not.toHaveBeenCalled();
    expect(p.group("Alpha").querySelectorAll('[role="option"]')).toHaveLength(0);
    await p.key("ArrowDown");
    expect(p.rows().find((row) => row.hasAttribute("data-active"))?.dataset.value).toBe(
      "beta/middle",
    );
    await p.search("ALPHA");
    expect(p.rows().map((row) => row.dataset.value)).toEqual(["alpha/first", "alpha/last"]);
    expect(p.group("Alpha").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    await p.search("");
    expect(p.group("Alpha").querySelectorAll('[role="option"]')).toHaveLength(0);
    await p.search("missing");
    expect(p.rows()).toHaveLength(0);
    expect(p.picker.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(false);
    expect(p.params.onChange).not.toHaveBeenCalled();
  });

  it("keeps native group-button activation and Tab from selecting the active model", async () => {
    const p = await mount();
    const button = p.group("Alpha").querySelector<HTMLButtonElement>("button")!;
    expect(button.closest('[role="listbox"]')).toBeNull();
    const controls = p.picker.querySelector("input")!.getAttribute("aria-controls")!.split(" ");
    expect(controls.map((id) => document.getElementById(id)?.getAttribute("role"))).toEqual([
      "listbox",
      "listbox",
      "listbox",
    ]);
    button.focus();
    expect((await p.key("Enter", button)).defaultPrevented).toBe(false);
    expect((await p.key(" ", button)).defaultPrevented).toBe(false);
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.key("Tab", button);
    expect(p.trigger.getAttribute("aria-expanded")).toBe("true");
    await p.key("Escape", button);
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(p.trigger);
  });

  it.each([
    { inherit: undefined, disabledValue: null },
    { inherit: { model: "alpha/first" }, disabledValue: "" },
  ])(
    "preserves Disabled and inheritance semantics with $inherit",
    async ({ inherit, disabledValue }) => {
      const p = await mount({ inherit, value: inherit ? null : "alpha/first" });
      if (inherit) {
        const inherited = p.rows().find((row) => row.textContent?.includes("Use global default"))!;
        expect(inherited.closest('[role="group"]')).toBeNull();
        await choosePickerValue(p.trigger, "beta/middle");
        await choosePickerValue(p.trigger, inherited.dataset.value!);
        expect(p.params.onChange).toHaveBeenLastCalledWith(null);
      }
      await choosePickerValue(p.trigger, "");
      expect(p.params.onChange).toHaveBeenLastCalledWith(disabledValue);
    },
  );

  it("retains an unavailable selection and prevents stale catalog and read-only writes", async () => {
    const p = await mount();
    await p.search("alpha/first");
    const stale = p.rows()[0]!;
    await p.update({ models: models.filter((m) => m.id !== "first") });
    stale.click();
    await p.key("Enter");
    expect(p.params.onChange).not.toHaveBeenCalled();
    expect(p.trigger.textContent).toContain("alpha/first");
    expect(p.rows()[0]!.getAttribute("aria-disabled")).toBe("true");
    await p.update({ disabled: true });
    expect(p.trigger.disabled).toBe(true);
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
