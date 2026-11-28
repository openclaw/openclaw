import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { choosePickerValue, openPicker, updatePickers } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SelectPicker } from "../select-picker.ts";
import { installTitleTooltips } from "../tooltip-title.ts";
import { DecisionModelPicker, type DecisionModelPickerParams } from "./decision-model-picker.tsx";
import { ModelPicker, type ModelPickerParams } from "./model-picker.tsx";

const fixture = (name: string, description?: string) => ({
  value: `openai/fixture-${name.toLowerCase()}`,
  label: `Fixture ${name}`,
  provider: "openai",
  description,
});
async function mountPicker(params: () => Partial<ModelPickerParams>) {
  const onChange = vi.fn();
  const view = mountSolid(() => (
    <ModelPicker
      label="Model"
      value="openai/fixture-alpha"
      options={[{ value: "", label: "Default" }, fixture("Alpha")]}
      onChange={onChange}
      {...params()}
    />
  ));
  await updatePickers(view.container);
  const picker = view.container.querySelector<SelectPicker>("openclaw-select-picker")!;
  const option = (value: string) =>
    picker.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)!;
  return { ...view, picker, option, onChange };
}
const settle = async () => {
  await Promise.resolve();
  flush();
};

describe("Solid model picker interop", () => {
  it("renders provider nodes and selected details through the existing picker owner", async () => {
    const onChange = vi.fn();
    const [params, setParams] = createSignal<ModelPickerParams>({
      label: "Model",
      value: "openai/selected",
      groupByProvider: true,
      showSelectedDetail: true,
      options: [
        { value: "", label: "Automatic" },
        { value: "openai/other", label: "Other", provider: "openai", disabled: true },
        { value: "openai/selected", label: "Selected", provider: "openai", description: "API" },
      ],
      onChange,
    });
    const view = await mountPicker(params);
    const { picker } = view;
    const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
    expect(trigger.textContent).toMatch(/Selected[\s\S]*API/);
    expect(trigger.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    await openPicker(picker);
    const group = picker.querySelector('[role="group"][aria-label="OpenAI"]')!;
    expect(group.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(
      [...group.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.dataset.value),
    ).toEqual(["openai/selected", "openai/other"]);
    await choosePickerValue(picker, "openai/other");
    await choosePickerValue(picker, "");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("");
    setParams((current) => ({
      ...current,
      value: "openai/new",
      disabled: true,
      options: [
        { value: "openai/new", label: "New model", provider: "openai", description: "Updated API" },
      ],
    }));
    flush();
    await updatePickers(view.container);
    expect(view.container.querySelector("openclaw-select-picker")).toBe(picker);
    expect(picker.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled).toBe(true);
    expect(picker.textContent).toContain("New model");
    expect(trigger.textContent).toContain("Updated API");
  });

  it.each([
    { commit: undefined, value: "__openclaw_custom_model__", initiallyHidden: true },
    { commit: "change" as const, value: "vendor/current", initiallyHidden: false },
  ])(
    "commits custom models on $commit without publishing the sentinel",
    async ({ commit, value, initiallyHidden }) => {
      const onChange = vi.fn();
      const [params, setParams] = createSignal<ModelPickerParams>({
        label: "Model",
        value,
        options: [{ value: "__openclaw_custom_model__", label: "Real model" }],
        custom: { label: "Custom model", commit },
        onChange,
      });
      const view = await mountPicker(params);
      const { picker } = view;
      const input = view.container.querySelector<HTMLInputElement>(".model-picker__custom")!;
      expect(input.hidden).toBe(initiallyHidden);
      await openPicker(picker);
      const custom = [...picker.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (row) => row.textContent?.trim() === "Custom model",
      )!;
      await choosePickerValue(picker, "__openclaw_custom_model__");
      expect(input.hidden).toBe(true);
      await choosePickerValue(picker, custom.dataset.value!);
      expect(input.hidden).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(onChange).toHaveBeenCalledExactlyOnceWith("__openclaw_custom_model__");
      input.value = "vendor/custom model";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setParams((current) => ({ ...current, title: "Updated model information" }));
      flush();
      expect(input.value).toBe("vendor/custom model");
      expect(document.activeElement).toBe(input);
      expect(onChange.mock.calls).toEqual([
        ["__openclaw_custom_model__"],
        ...(commit === "change" ? [] : [["vendor/custom model"]]),
      ]);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onChange.mock.calls).toEqual([["__openclaw_custom_model__"], ["vendor/custom model"]]);
      setParams((current) => ({ ...current, value: "vendor/updated" }));
      flush();
      expect(input.value).toBe("vendor/updated");
    },
  );

  it("keeps inherited and explicitly disabled decision models distinct", async () => {
    const onChange = vi.fn();
    const [params, setParams] = createSignal<DecisionModelPickerParams>({
      id: "decision",
      models: [{ id: "quick", name: "Quick", provider: "fixture", pluginId: "fixture" }],
      value: null,
      inherit: { model: "fixture/quick" },
      disabled: false,
      onChange,
    });
    const view = mountSolid(() => <DecisionModelPicker {...params()} />);
    await updatePickers(view.container);
    const picker = view.container.querySelector<SelectPicker>("openclaw-select-picker")!;
    const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
    expect(trigger.textContent).toContain("Use global default");
    await choosePickerValue(picker, "");
    expect(onChange).toHaveBeenLastCalledWith("");
    await choosePickerValue(picker, "__openclaw_inherit_decision__");
    expect(onChange).toHaveBeenLastCalledWith(null);
    await choosePickerValue(picker, "fixture/quick");
    expect(onChange).toHaveBeenLastCalledWith("fixture/quick");
    setParams((current) => ({
      ...current,
      models: [{ id: "new", name: "New decision model", provider: "fixture", pluginId: "fixture" }],
      value: "fixture/new",
      disabled: true,
    }));
    flush();
    await updatePickers(view.container);
    expect(view.container.querySelector("openclaw-select-picker")).toBe(picker);
    expect(trigger.disabled).toBe(true);
    expect(picker.textContent).toContain("New decision model");
  });

  it("settles disabled provider groups and allows re-enabling", async () => {
    const [disabled, setDisabled] = createSignal(false);
    const { container, picker, onChange } = await mountPicker(() => ({
      options: [fixture("Alpha"), fixture("Beta")],
      get disabled() {
        return disabled();
      },
      groupByProvider: true,
    }));
    const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
    const group = () => picker.querySelector<HTMLButtonElement>(".picker-select__group-toggle");
    await openPicker(picker);
    group()!.click();
    flush();
    expect(group()?.getAttribute("aria-expanded")).toBe("false");
    setDisabled(true);
    flush();
    await settle();
    expect(trigger.disabled).toBe(true);
    expect(group()).toBeNull();
    container.append(document.createElement("span"));
    // Deliver the registry mutation, then settle its consumers.
    await settle();
    expect(group()).toBeNull();
    setDisabled(false);
    flush();
    await openPicker(picker);
    expect(group()?.getAttribute("aria-expanded")).toBe("true");
    await choosePickerValue(picker, "openai/fixture-beta");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("openai/fixture-beta");
  });

  it("puts a late selection first without truncating a large catalog", async () => {
    const { container, picker } = await mountPicker(() => ({
      value: "fixture/model-299",
      options: Array.from({ length: 300 }, (_, index) => ({
        value: `fixture/model-${String(index).padStart(3, "0")}`,
        label: `Model ${index}`,
        provider: "fixture",
      })),
    }));
    await openPicker(picker);
    const rows = [...container.querySelectorAll('[role="option"][data-value]')];
    expect(rows).toHaveLength(300);
    expect(rows.slice(0, 3).map((row) => row.getAttribute("data-value"))).toEqual([
      "fixture/model-299",
      "fixture/model-000",
      "fixture/model-001",
    ]);
  });

  it("preserves an unknown model in the menu", async () => {
    const { picker, option } = await mountPicker(() => ({ value: "legacy/model" }));
    await openPicker(picker);
    expect(option("legacy/model").textContent).toContain("legacy/model");
  });

  it("keeps raw references out of hover tooltips and selects the hovered model", async () => {
    const { picker, option, onChange } = await mountPicker(() => ({
      showSelectedDetail: true,
      options: [{ value: "", label: "Automatic" }, fixture("Alpha", "API"), fixture("Beta", "API")],
    }));
    const dispose = installTitleTooltips(document);
    try {
      await openPicker(picker);
      expect(option("").querySelector(".picker-select__leading")).toBeNull();
      const row = option("openai/fixture-beta");
      expect(row.textContent).toContain("API");
      row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
      expect(document.querySelector("openclaw-tooltip")?.content ?? "").toBe("");
      row.click();
      await picker.updateComplete;
      expect(onChange).toHaveBeenCalledExactlyOnceWith("openai/fixture-beta");
    } finally {
      dispose();
    }
  });
});
