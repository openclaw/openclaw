import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../test-helpers/select-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import { ModelPicker } from "./solid/model-picker.tsx";
import { installTitleTooltips } from "./tooltip-title.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("ModelPicker", () => {
  it("keeps disabled provider groups settled and usable after re-enabling", async () => {
    const [disabled, setDisabled] = createSignal(false);
    const onChange = vi.fn();
    const { container } = mountSolid(() => (
      <ModelPicker
        label="Model"
        value="fixture/alpha"
        options={[
          { value: "fixture/alpha", label: "Alpha", provider: "fixture" },
          { value: "fixture/beta", label: "Beta", provider: "fixture" },
        ]}
        disabled={disabled()}
        groupByProvider
        onChange={onChange}
      />
    ));
    await updatePickers(container);
    const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    const trigger = picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
    trigger.click();
    await picker.updateComplete;
    const group = picker.querySelector<HTMLButtonElement>(".picker-select__group-toggle")!;
    group.click();
    flush();
    expect(group.getAttribute("aria-expanded")).toBe("false");

    setDisabled(true);
    flush();
    await Promise.resolve();
    flush();
    const icon = group.querySelector(".provider-brand-icon");
    expect(icon).not.toBeNull();
    expect(trigger.disabled).toBe(true);
    container.append(document.createElement("span"));
    // Deliver the registry's document-mutation observation, then settle its consumers.
    await Promise.resolve();
    flush();
    expect(group.querySelector(".provider-brand-icon")).toBe(icon);

    setDisabled(false);
    flush();
    await choosePickerValue(picker, "fixture/beta");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/beta");
  });

  it("shows a late selected model first without dropping the rest of a large catalog", async () => {
    const { container } = mountSolid(() => (
      <ModelPicker
        label="Model"
        value="fixture/model-299"
        options={Array.from({ length: 300 }, (_, index) => ({
          value: `fixture/model-${String(index).padStart(3, "0")}`,
          label: `Model ${index}`,
          provider: "fixture",
        }))}
        onChange={vi.fn()}
      />
    ));
    await updatePickers(container);
    await openPicker(container.querySelector("openclaw-select-picker")!);
    const rows = Array.from(container.querySelectorAll('[role="option"][data-value]'));
    expect(rows).toHaveLength(300);
    expect(rows.slice(0, 3).map((row) => row.getAttribute("data-value"))).toEqual([
      "fixture/model-299",
      "fixture/model-000",
      "fixture/model-001",
    ]);
  });

  it("renders provider details and caller sentinels while preserving an unknown current model", async () => {
    const { container } = mountSolid(() => (
      <ModelPicker
        label="Model"
        value="legacy/model"
        options={[
          { value: "", label: "Automatic" },
          {
            value: "openai/fixture-alpha",
            label: "Fixture Alpha",
            provider: "openai",
            detail: "Fast · 128k",
            disabled: true,
          },
        ]}
        onChange={vi.fn()}
      />
    ));
    await updatePickers(container);
    await openPicker(container.querySelector("openclaw-select-picker")!);

    expect(
      container.querySelector('[role="option"][data-value=""] .picker-select__leading'),
    ).toBeNull();
    const openai = container.querySelector('[role="option"][data-value="openai/fixture-alpha"]');
    expect(openai?.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(openai?.textContent).toContain("Fast · 128k");
    expect(openai?.getAttribute("aria-disabled") === "true").toBe(true);
    expect(
      container.querySelector('[role="option"][data-value="legacy/model"]')?.textContent,
    ).toContain("legacy/model");
  });

  it("reveals free-form entry without leaking its internal option value", async () => {
    const onChange = vi.fn();
    const { container } = mountSolid(() => (
      <ModelPicker
        label="Model"
        value="openai/fixture-alpha"
        options={[
          { value: "", label: "Default" },
          { value: "openai/fixture-alpha", label: "Fixture Alpha", provider: "openai" },
        ]}
        custom={{ label: "Custom model…", placeholder: "provider/model" }}
        onChange={onChange}
      />
    ));
    await updatePickers(container);
    await openPicker(container.querySelector("openclaw-select-picker")!);

    const customOption = Array.from(container.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent?.trim() === "Custom model…",
    );
    const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(customOption).not.toBeNull();
    expect(input?.hidden).toBe(true);
    await choosePickerValue(picker, customOption!.getAttribute("data-value")!);
    expect(input.hidden).toBe(false);

    input.value = "vendor/model with spaces";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("vendor/model with spaces");
    expect(onChange).not.toHaveBeenCalledWith(customOption!.getAttribute("data-value"));
  });

  it("does not show a raw model reference when a model option receives pointer hover", async () => {
    const onChange = vi.fn();
    const { container: host, unmount } = mountSolid(() => (
      <ModelPicker
        label="Model"
        value="openai/fixture-alpha"
        showSelectedDetail
        options={[
          { value: "", label: "Select a model", disabled: true },
          {
            value: "openai/fixture-alpha",
            label: "Fixture Alpha",
            provider: "openai",
            detail: "API",
          },
          {
            value: "openai/fixture-beta",
            label: "Fixture Beta",
            provider: "openai",
            detail: "API",
          },
        ]}
        onChange={onChange}
      />
    ));
    const dispose = installTitleTooltips(document);
    try {
      await updatePickers(host);
      const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
      await openPicker(picker);
      const row = picker.querySelector<HTMLElement>(
        '[role="option"][data-value="openai/fixture-beta"]',
      )!;
      expect(row.textContent).toContain("Fixture Beta");
      expect(row.textContent).toContain("API");
      expect(row.querySelector("[data-provider-icon]")).not.toBeNull();
      row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
      const tooltip = document.querySelector("openclaw-tooltip");
      expect(tooltip?.content ?? "").toBe("");
      row.click();
      await picker.updateComplete;
      expect(onChange).toHaveBeenCalledExactlyOnceWith("openai/fixture-beta");
    } finally {
      dispose();
      unmount();
    }
  });
});
