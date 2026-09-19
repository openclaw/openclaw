import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { renderChatModelAccountControl } from "./chat-model-account-control.ts";
import { renderChatModelPicker } from "./chat-model-picker.ts";

describe("model picker pointer intent", () => {
  it.each([
    '[data-chat-model-option="openai/beta"]',
    '[data-chat-model-target="terminal"]',
    '[data-chat-account-option="manage"]',
  ])("keeps keyboard highlight until a pointer moves over %s", async (selector) => {
    const container = document.createElement("div");
    onTestFinished(() => {
      render(nothing, container);
    });
    const onModelSelect = vi.fn(async () => true);
    const onTargetSelect = vi.fn();
    const onManage = vi.fn();
    const selection = { kind: "automatic" as const, label: "Automatic" };
    let pickerOpen = true;
    const draw = () =>
      render(
        renderChatModelPicker({
          open: pickerOpen,
          onOpenChange: (open) => {
            pickerOpen = open;
          },
          disabled: false,
          modelSelectionLocked: false,
          selectedModelValue: "openai/alpha",
          sessionModelPinned: false,
          sessionKey: "main",
          triggerModelLabel: "Alpha",
          modelOptions: ["alpha", "beta"].map((name) => ({
            value: `openai/${name}`,
            commitValue: `openai/${name}`,
            provider: "openai",
            label: name,
            isDefault: name === "alpha",
          })),
          onModelSelect,
          onTargetSelect,
          targetGroups: [
            {
              id: "fixture",
              label: "Targets",
              status: "ready",
              errorLabel: "Unavailable",
              options: [{ label: "Terminal", value: "terminal" }],
            },
          ],
          accountSection: renderChatModelAccountControl({
            owner: container,
            client: null,
            selection,
            model: "openai/alpha",
            disabled: false,
            ownsSelection: () => true,
            onSelect: vi.fn(async () => true),
            onManage,
            onRequestUpdate: draw,
          }),
        }),
        container,
      );
    draw();
    expectDefined(
      container.querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]"),
      "account group toggle",
    ).click();
    await Promise.resolve();
    const search = expectDefined(
      container.querySelector<HTMLInputElement>("[data-chat-model-search]"),
      "model search input",
    );
    const alpha = expectDefined(
      container.querySelector<HTMLButtonElement>('[data-chat-model-option="openai/alpha"]'),
      "keyboard-selected Alpha row",
    );
    const row = expectDefined(container.querySelector<HTMLButtonElement>(selector), selector);
    const resetKeyboardHighlight = () => {
      search.dispatchEvent(new InputEvent("input", { bubbles: true }));
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      expect(search.getAttribute("aria-activedescendant")).toBe(alpha.id);
    };

    resetKeyboardHighlight();
    row.dispatchEvent(new MouseEvent("mouseenter"));
    expect(search.getAttribute("aria-activedescendant")).toBe(alpha.id);
    row.dispatchEvent(new PointerEvent("pointermove", { pointerType: "touch", bubbles: true }));
    expect(search.getAttribute("aria-activedescendant")).toBe(alpha.id);

    for (const pointerType of ["mouse", "pen"]) {
      resetKeyboardHighlight();
      row.dispatchEvent(new PointerEvent("pointermove", { pointerType, bubbles: true }));
      expect(search.getAttribute("aria-activedescendant")).toBe(row.id);
      expect(row.hasAttribute("data-chat-model-highlighted")).toBe(true);
      const observer = new MutationObserver(() => {});
      observer.observe(container, { attributes: true, subtree: true });
      row.dispatchEvent(new PointerEvent("pointermove", { pointerType, bubbles: true }));
      const repeatedMoveMutations = observer.takeRecords();
      observer.disconnect();
      expect(repeatedMoveMutations).toHaveLength(0);
    }

    resetKeyboardHighlight();
    row.click();
    if (selector.includes("model-target")) {
      expect(onTargetSelect).toHaveBeenCalledExactlyOnceWith("fixture", "terminal");
    } else if (selector.includes("account-option")) {
      expect(onManage).toHaveBeenCalledOnce();
    } else {
      expect(onModelSelect).toHaveBeenCalledExactlyOnceWith("openai/beta", "main", null);
    }
  });
});
