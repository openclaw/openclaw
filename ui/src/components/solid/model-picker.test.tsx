/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SelectPicker } from "../select-picker.ts";
import { DecisionModelPicker } from "./decision-model-picker.tsx";
import { ModelPicker, type ModelPickerParams } from "./model-picker.tsx";

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
        { value: "openai/selected", label: "Selected", provider: "openai", detail: "API" },
      ],
      onChange,
    });
    const view = mountSolid(() => <ModelPicker {...params()} />);
    await updatePickers(view.container);
    const picker = view.container.querySelector<SelectPicker>("openclaw-select-picker")!;
    const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
    expect(trigger.textContent).toContain("Selected");
    expect(trigger.textContent).toContain("API");
    expect(trigger.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    trigger.click();
    await picker.updateComplete;
    const group = picker.querySelector('[role="group"][aria-label="OpenAI"]')!;
    expect(group.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(
      [...group.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.dataset.value),
    ).toEqual(["openai/selected", "openai/other"]);
    await choosePickerValue(picker, "openai/other");
    expect(onChange).not.toHaveBeenCalled();
    await choosePickerValue(picker, "");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("");
    setParams((current) => ({
      ...current,
      value: "openai/new",
      disabled: true,
      options: [{ value: "openai/new", label: "New model", provider: "openai" }],
    }));
    flush();
    await updatePickers(view.container);
    expect(view.container.querySelector("openclaw-select-picker")).toBe(picker);
    expect(picker.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled).toBe(true);
    expect(picker.textContent).toContain("New model");
  });

  it("reveals a custom editor without publishing its sentinel and commits on the configured event", async () => {
    const onChange = vi.fn();
    const view = mountSolid(() => (
      <ModelPicker
        label={"Model"}
        value={"vendor/current"}
        options={[{ value: "__openclaw_custom_model__", label: "Real model" }]}
        custom={{ label: "Custom model", commit: "change" }}
        onChange={onChange}
      />
    ));
    await updatePickers(view.container);
    const picker = view.container.querySelector<SelectPicker>("openclaw-select-picker")!;
    const input = view.container.querySelector<HTMLInputElement>(".model-picker__custom")!;
    const custom = [...picker.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (row) => row.textContent?.trim() === "Custom model",
    )!;
    await choosePickerValue(picker, "__openclaw_custom_model__");
    expect(input.hidden).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("__openclaw_custom_model__");
    onChange.mockClear();
    await choosePickerValue(picker, custom.dataset.value!);
    expect(input.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(onChange).not.toHaveBeenCalled();
    input.value = "vendor/custom model";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("vendor/custom model");
  });

  it("keeps inherited and explicitly disabled decision models distinct", async () => {
    const onChange = vi.fn();
    const view = mountSolid(() => (
      <DecisionModelPicker
        id={"decision"}
        models={[{ id: "quick", name: "Quick", provider: "fixture", pluginId: "fixture" }]}
        value={null}
        inherit={{ model: "fixture/quick" }}
        disabled={false}
        onChange={onChange}
      />
    ));
    await updatePickers(view.container);
    const picker = view.container.querySelector<SelectPicker>("openclaw-select-picker")!;
    expect(picker.querySelector(".picker-select__trigger")?.textContent).toContain(
      "Use global default",
    );
    await choosePickerValue(picker, "");
    expect(onChange).toHaveBeenLastCalledWith("");
    await choosePickerValue(picker, "__openclaw_inherit_decision__");
    expect(onChange).toHaveBeenLastCalledWith(null);
    await choosePickerValue(picker, "fixture/quick");
    expect(onChange).toHaveBeenLastCalledWith("fixture/quick");
  });
});
