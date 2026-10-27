import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SelectPicker } from "../select-picker.ts";
import { InteractionModelPicker } from "./interaction-model-picker.tsx";

describe("interaction model picker", () => {
  it("preserves inheritance versus chat control, rejects text-only choices and stays reactive", async () => {
    const change = vi.fn();
    const [value, setValue] = createSignal<string | null>(null);
    const [disabled, setDisabled] = createSignal(false);
    const view = mountSolid(() => (
      <InteractionModelPicker
        id="computer-model"
        kind="computer"
        models={[
          {
            provider: "fixture",
            id: "vision",
            name: "Vision",
            input: ["text", "image"],
            available: true,
          },
          { provider: "fixture", id: "text", name: "Text only", input: ["text"], available: true },
        ]}
        value={value()}
        inherit={{ model: "fixture/global" }}
        disabled={disabled()}
        onChange={change}
      />
    ));
    await updatePickers(view.container);
    const picker = view.container.querySelector<SelectPicker>("openclaw-select-picker")!;
    expect(picker.textContent).toContain("Inherit default");
    await choosePickerValue(picker, "fixture/text");
    expect(change).not.toHaveBeenCalled();
    await choosePickerValue(picker, "fixture/vision");
    expect(change).toHaveBeenLastCalledWith("fixture/vision");
    await choosePickerValue(picker, "");
    expect(change).toHaveBeenLastCalledWith("");
    await choosePickerValue(picker, "__openclaw_inherit_interaction__");
    expect(change).toHaveBeenLastCalledWith(null);
    setValue("fixture/vision");
    setDisabled(true);
    flush();
    await updatePickers(view.container);
    expect(view.container.querySelector("openclaw-select-picker")).toBe(picker);
    expect(picker.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled).toBe(true);
    expect(picker.textContent).toContain("Vision");
  });
});
