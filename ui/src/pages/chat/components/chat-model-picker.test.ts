/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import { renderChatModelPicker } from "./chat-model-picker.ts";

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
