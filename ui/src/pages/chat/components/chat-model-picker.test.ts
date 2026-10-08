/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import { renderChatModelPicker } from "./chat-model-picker.ts";

it.each([false, true])(
  "initially expands the selected provider and retains toggles on reopen (inherited=%s)",
  async (inherited) => {
    const container = document.createElement("div");
    const params: Parameters<typeof renderChatModelPicker>[0] = {
      disabled: false,
      modelSelectionLocked: false,
      modelOptions: [
        {
          provider: "other",
          value: "other/first",
          commitValue: "other/first",
          label: "Other",
          isDefault: false,
        },
        {
          provider: "selected",
          value: "selected/current",
          commitValue: inherited ? "" : "selected/current",
          label: "Current",
          isDefault: inherited,
        },
      ],
      selectedModelValue: inherited ? "" : "selected/current",
      sessionModelPinned: !inherited,
      sessionKey: "main",
      triggerModelLabel: "Current",
      open: true,
      onModelSelect: vi.fn(async () => {}),
    };
    render(renderChatModelPicker(params), container);
    await Promise.resolve();
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    const selected = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="selected/current"]',
    )!;
    const other = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="other/first"]',
    )!;
    const toggle = selected
      .closest("section")!
      .querySelector<HTMLButtonElement>("[data-chat-model-provider-toggle]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(selected.hidden).toBe(false);
    expect(other.hidden).toBe(true);

    // A deliberate collapse survives closing and reopening the picker.
    toggle.click();
    expect(selected.hidden).toBe(true);
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(selected.hidden).toBe(true);
    expect(other.hidden).toBe(true);

    // The next selection, including a change while closed, owns the open group.
    render(
      renderChatModelPicker({ ...params, open: false, selectedModelValue: "other/first" }),
      container,
    );
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(other.hidden).toBe(false);
    expect(selected.hidden).toBe(true);
  },
);

it.each([false, true])("keeps current visible with Default=%s", (hasDefault) => {
  const container = document.createElement("div");
  render(
    renderChatModelPicker({
      disabled: false,
      modelSelectionLocked: false,
      modelOptions: Array.from({ length: 300 }, (_, index) => ({
        provider: "fixture",
        value: `fixture/model-${index}`,
        commitValue: hasDefault && index === 0 ? "" : `fixture/model-${index}`,
        label: `Model ${index}`,
        isDefault: hasDefault && index === 0,
      })),
      selectedModelValue: "fixture/model-299",
      sessionModelPinned: true,
      sessionKey: "main",
      triggerModelLabel: "Model 299",
      onModelSelect: vi.fn(async () => {}),
    }),
    container,
  );
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-option]"));
  expect(rows).toHaveLength(300);
  expect(rows.slice(0, 3).map((row) => row.dataset.chatModelOption)).toEqual(
    hasDefault
      ? ["fixture/model-0", "fixture/model-299", "fixture/model-1"]
      : ["fixture/model-299", "fixture/model-0", "fixture/model-1"],
  );
  expect(rows[hasDefault ? 1 : 0]?.getAttribute("aria-selected")).toBe("true");
});
