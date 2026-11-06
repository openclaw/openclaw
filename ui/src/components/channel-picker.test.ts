/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../test-helpers/select-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import { ChannelPicker } from "./solid/channel-picker.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("ChannelPicker", () => {
  it("renders channel placeholders and neutral choices while preserving a missing current channel", async () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        createComponent(ChannelPicker, {
          label: "Channel",
          value: "retired-channel",
          options: [
            { value: "last", label: "last", kind: "neutral" },
            { value: "telegram", label: "Telegram" },
          ],
          onChange: vi.fn(),
        }),
      { container },
    );
    await updatePickers(container);
    await openPicker(container.querySelector("openclaw-select-picker")!);

    expect(
      container.querySelector('[role="option"][data-value="last"] .picker-select__leading'),
    ).toBeNull();
    const telegram = container.querySelector('[role="option"][data-value="telegram"]');
    expect(telegram?.querySelector("img")).toBeNull();
    expect(telegram?.querySelector(".channels-tile--fallback")?.textContent?.trim()).toBe("TE");
    expect(
      container.querySelector('[role="option"][data-value="retired-channel"]')?.textContent,
    ).toContain("retired-channel");
    expect(
      container.querySelector(
        '[role="option"][data-value="retired-channel"] .channels-tile--fallback',
      ),
    ).not.toBeNull();
  });

  it("honors disabled choices and reports enabled changes", async () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    mountSolid(
      () =>
        createComponent(ChannelPicker, {
          label: "Channel",
          value: "telegram",
          options: [
            { value: "telegram", label: "Telegram" },
            { value: "disabled", label: "Disabled", disabled: true },
          ],
          onChange,
        }),
      { container },
    );
    await updatePickers(container);

    const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    await openPicker(picker);
    expect(
      container
        .querySelector('[role="option"][data-value="disabled"]')
        ?.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await choosePickerValue(picker, "disabled");
    expect(onChange).not.toHaveBeenCalled();
    await choosePickerValue(picker, "telegram");
    expect(onChange).toHaveBeenCalledWith("telegram");
  });
});
