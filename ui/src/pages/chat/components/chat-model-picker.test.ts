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

it("greys out a model the account is not provisioned for without routing to setup", () => {
  const container = document.createElement("div");
  const onModelSelect = vi.fn(async () => {});
  const onModelSetup = vi.fn();
  render(
    renderChatModelPicker({
      disabled: false,
      modelSelectionLocked: false,
      modelOptions: [
        {
          provider: "anthropic",
          value: "anthropic/claude-opus-5",
          commitValue: "anthropic/claude-opus-5",
          label: "Claude Opus 5",
          isDefault: false,
        },
        {
          provider: "anthropic",
          value: "anthropic/claude-mythos-5",
          commitValue: "anthropic/claude-mythos-5",
          label: "Claude Mythos 5",
          isDefault: false,
          disabled: true,
          unavailableReason: "not-provisioned",
        },
        {
          provider: "anthropic",
          value: "anthropic/claude-sonnet-5",
          commitValue: "anthropic/claude-sonnet-5",
          label: "Claude Sonnet 5",
          isDefault: false,
          disabled: true,
          unavailableReason: "missing-auth",
        },
      ],
      selectedModelValue: "anthropic/claude-opus-5",
      sessionModelPinned: false,
      sessionKey: "main",
      triggerModelLabel: "Claude Opus 5",
      onModelSelect,
      onModelSetup,
    }),
    container,
  );
  const unlisted = container.querySelector<HTMLButtonElement>(
    '[data-chat-model-option="anthropic/claude-mythos-5"]',
  );
  const needsAuth = container.querySelector<HTMLButtonElement>(
    '[data-chat-model-option="anthropic/claude-sonnet-5"]',
  );
  expect(unlisted?.disabled).toBe(true);
  expect(unlisted?.dataset.chatModelSetup).toBeUndefined();
  expect(unlisted?.getAttribute("title")).toBe("Not available for the connected account.");
  // A sign-in-gated row keeps its recovery path; an unprovisioned row has none.
  expect(needsAuth?.disabled).toBe(false);
  expect(needsAuth?.dataset.chatModelSetup).toBe("true");
  unlisted?.click();
  expect(onModelSelect).not.toHaveBeenCalled();
  expect(onModelSetup).not.toHaveBeenCalled();
});
