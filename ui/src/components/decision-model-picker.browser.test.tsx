import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { updatePickers } from "../test-helpers/select-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import { DecisionModelPicker, type DecisionModelEntry } from "./solid/decision-model-picker.tsx";

const models: DecisionModelEntry[] = [
  { provider: "alpha", id: "last", name: "Zulu", pluginId: "alpha" },
  { provider: "beta", id: "middle", name: "Middle", pluginId: "beta" },
  { provider: "alpha", id: "first", name: "First", pluginId: "alpha" },
];
async function mount(overrides: Partial<Parameters<typeof DecisionModelPicker>[0]> = {}) {
  const params = {
    id: "decision",
    models,
    value: "alpha/first",
    disabled: false,
    onChange: vi.fn(),
    ...overrides,
  };
  const [props, setProps] = createSignal({ ...params });
  const { container } = mountSolid(() => <DecisionModelPicker {...props()} />);
  const update = async (patch: Partial<typeof params> = {}) => {
    Object.assign(params, patch);
    setProps({ ...params });
    flush();
    await updatePickers(container);
  };
  await update();
  const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
  const find = (selector: string) => picker.querySelector<HTMLElement>(selector)!;
  const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
  await userEvent.click(trigger);
  await expect.element(find("input")).toHaveFocus();
  const rows = () => [...picker.querySelectorAll<HTMLElement>('[role="option"]')];
  const search = (value: string) => userEvent.fill(find("input"), value);
  const key = async (value: string) => {
    find("input").focus();
    await userEvent.keyboard(value === " " ? " " : `{${value}}`);
  };
  const group = (label: string) => find('[role="group"][aria-label="' + label + '"]');
  const toggle = (label: string) =>
    userEvent.click(group(label).querySelector<HTMLButtonElement>("button")!);
  const choose = async (value: string) => {
    if (trigger.getAttribute("aria-expanded") !== "true") {
      await userEvent.click(trigger);
    }
    await userEvent.click(rows().find((option) => option.dataset.value === value)!);
  };
  return { params, picker, trigger, update, rows, search, key, group, toggle, choose };
}

describe("decision model provider groups", () => {
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

  it("groups models in keyboard order and maps Disabled to null", async () => {
    const p = await mount();
    expect(p.group("Alpha").querySelector("button")!.closest('[role="listbox"]')).toBeNull();
    const controls = p.picker.querySelector("input")!.getAttribute("aria-controls")!.split(" ");
    expect(controls.map((id) => document.getElementById(id)?.getAttribute("role"))).toEqual([
      "listbox",
      "listbox",
      "listbox",
    ]);
    expect(
      [...p.picker.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Alpha", "Beta"]);
    const values = p.rows().map((row) => row.dataset.value);
    expect(values).toEqual(["", "alpha/first", "alpha/last", "beta/middle"]);
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
    await p.choose("");
    expect(p.params.onChange).toHaveBeenLastCalledWith(null);
  });

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
