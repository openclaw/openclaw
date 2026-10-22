import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../test-helpers/select-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import { ModelPicker } from "./solid/model-picker.tsx";
import { installTitleTooltips } from "./tooltip-title.ts";

const fixture = (name: string, detail?: string) => ({
  value: `openai/fixture-${name.toLowerCase()}`,
  label: `Fixture ${name}`,
  provider: "openai",
  detail,
});
async function mountPicker(
  props: Partial<Omit<Parameters<typeof ModelPicker>[0], "label" | "onChange">>,
) {
  const onChange = vi.fn();
  const view = mountSolid(() => (
    <ModelPicker
      label="Model"
      value="openai/fixture-alpha"
      options={[{ value: "", label: "Default" }, fixture("Alpha")]}
      onChange={onChange}
      {...props}
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

it("settles disabled provider groups and allows re-enabling", async () => {
  const [disabled, setDisabled] = createSignal(false);
  const { container, picker, onChange } = await mountPicker({
    value: "fixture/alpha",
    options: ["Alpha", "Beta"].map((label) => ({
      value: `fixture/${label.toLowerCase()}`,
      label,
      provider: "fixture",
    })),
    get disabled() {
      return disabled();
    },
    groupByProvider: true,
  });
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
  await choosePickerValue(picker, "fixture/beta");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/beta");
});

it("puts a late selection first without truncating a large catalog", async () => {
  const { container, picker } = await mountPicker({
    value: "fixture/model-299",
    options: Array.from({ length: 300 }, (_, index) => ({
      value: `fixture/model-${String(index).padStart(3, "0")}`,
      label: `Model ${index}`,
      provider: "fixture",
    })),
  });
  await openPicker(picker);
  const rows = [...container.querySelectorAll('[role="option"][data-value]')];
  expect(rows).toHaveLength(300);
  expect(rows.slice(0, 3).map((row) => row.getAttribute("data-value"))).toEqual([
    "fixture/model-299",
    "fixture/model-000",
    "fixture/model-001",
  ]);
});

it("renders provider details and sentinels while preserving unknown models", async () => {
  const { picker, option } = await mountPicker({
    value: "legacy/model",
    options: [
      { value: "", label: "Automatic" },
      { ...fixture("Alpha", "Fast · 128k"), disabled: true },
    ],
  });
  await openPicker(picker);
  expect(option("").querySelector(".picker-select__leading")).toBeNull();
  const openai = option("openai/fixture-alpha");
  expect(openai.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
  expect(openai).toMatchObject({ textContent: expect.stringContaining("Fast · 128k") });
  expect(openai.getAttribute("aria-disabled")).toBe("true");
  expect(option("legacy/model").textContent).toContain("legacy/model");
});

it("reveals free-form entry without leaking its internal option value", async () => {
  const { container, picker, onChange } = await mountPicker({
    custom: { label: "Custom model…", placeholder: "provider/model" },
  });
  await openPicker(picker);
  const custom = [...container.querySelectorAll('[role="option"]')].find(
    (option) => option.textContent?.trim() === "Custom model…",
  );
  const input = container.querySelector<HTMLInputElement>("input")!;
  expect(custom).toBeDefined();
  expect(input.hidden).toBe(true);
  await choosePickerValue(picker, custom!.getAttribute("data-value")!);
  expect(input.hidden).toBe(false);
  input.value = "vendor/model with spaces";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(onChange).toHaveBeenCalledWith("vendor/model with spaces");
  expect(onChange).not.toHaveBeenCalledWith(custom!.getAttribute("data-value"));
});

it("keeps raw references out of hover tooltips and selects the hovered model", async () => {
  const { picker, option, onChange } = await mountPicker({
    showSelectedDetail: true,
    options: [fixture("Alpha", "API"), fixture("Beta", "API")],
  });
  const dispose = installTitleTooltips(document);
  try {
    await openPicker(picker);
    const row = option("openai/fixture-beta");
    row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(document.querySelector("openclaw-tooltip")?.content ?? "").toBe("");
    row.click();
    await picker.updateComplete;
    expect(onChange).toHaveBeenCalledExactlyOnceWith("openai/fixture-beta");
  } finally {
    dispose();
  }
});
