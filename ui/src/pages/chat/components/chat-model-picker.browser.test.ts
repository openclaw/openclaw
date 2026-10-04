import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { focusChatComposerFromPrintableKeydown } from "../chat-pane-shared.ts";
import { focusComposerFromChrome } from "./chat-composer-dom.ts";
import { renderChatModelPicker } from "./chat-model-picker.ts";
import { installChatComposerPickerDismissal } from "./chat-picker-overlay.ts";

const container = document.createElement("div");
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  render(nothing, container);
  container.remove();
});

function mountPicker() {
  document.body.append(container);
  dispose = installChatComposerPickerDismissal(document);
  const params = {
    disabled: false,
    modelSelectionLocked: false,
    selectedModelValue: "example/alpha",
    sessionModelPinned: true,
    sessionKey: "main",
    triggerModelLabel: "Alpha",
    modelOptions: ["Alpha", "Beta"].map((label) => ({
      label,
      value: "example/" + label.toLowerCase(),
      commitValue: "example/" + label.toLowerCase(),
      provider: "example",
      isDefault: false,
    })),
    onModelSelect: vi.fn(async () => {}),
  };
  const update = () =>
    render(
      html`
        <div
          class="agent-chat__input"
          @pointerdown=${(event: PointerEvent) => focusComposerFromChrome(event, true)}
          @click=${(event: MouseEvent) => focusComposerFromChrome(event, true)}
          @keydown=${(event: KeyboardEvent) => focusChatComposerFromPrintableKeydown(container, event)}
        >
          <div class="agent-chat__composer-combobox"><textarea></textarea></div>
          ${renderChatModelPicker(params)}
        </div>
      `,
      container,
    );
  update();
  const picker = container.querySelector("details")!;
  const trigger = picker.querySelector("summary")!;
  const search = picker.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  const composer = container.querySelector("textarea")!;
  const popup = picker.querySelector<WaPopup>("wa-popup")!;
  const toggle = async (activate: () => Promise<void>) => {
    const toggled = new Promise<void>((resolve) => {
      picker.addEventListener("toggle", () => resolve(), { once: true });
    });
    await activate();
    await toggled;
    await popup.updateComplete;
    await new Promise(requestAnimationFrame);
  };
  return { params, update, picker, trigger, search, composer, toggle };
}

it("focuses the filter after clicking the model label without changing the chat draft", async () => {
  const { search, composer, toggle } = mountPicker();
  composer.value = "Keep this draft";
  composer.focus();
  await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
  expect(document.activeElement).toBe(search);
  await userEvent.keyboard("beta");
  expect(search.value).toBe("beta");
  expect(composer.value).toBe("Keep this draft");
  expect(
    container.querySelector<HTMLButtonElement>('[data-chat-model-option="example/alpha"]')!.hidden,
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>('[data-chat-model-option="example/beta"]')!.hidden,
  ).toBe(false);
});

it("focuses the filter on keyboard open and reopen, and returns Escape to the trigger", async () => {
  const { picker, trigger, search, params, toggle } = mountPicker();
  trigger.focus();
  for (const key of ["{Enter}", " "]) {
    await toggle(() => userEvent.keyboard(key));
    expect(document.activeElement).toBe(search);
    await userEvent.keyboard("beta");
    await userEvent.keyboard("{Escape}");
    expect(search.value).toBe("");
    expect(picker.open).toBe(true);
    expect(document.activeElement).toBe(search);
    await toggle(() => userEvent.keyboard("{Escape}"));
    expect(picker.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  }
  expect(params.onModelSelect).not.toHaveBeenCalled();
});

it.each(["closed", "removed", "focus moved"])(
  "does not autofocus after opening is %s",
  async (state) => {
    const { picker, composer, toggle } = mountPicker();
    picker.addEventListener(
      "toggle",
      () => {
        if (state === "closed") {
          picker.open = false;
        } else if (state === "removed") {
          picker.remove();
        }
        composer.focus();
      },
      { once: true },
    );
    await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
    expect(document.activeElement).toBe(composer);
  },
);

it("does not steal focus from a picker control on catalog rerender", async () => {
  const { params, update, trigger, search, toggle } = mountPicker();
  await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
  await userEvent.keyboard("beta");
  // Filtering hides provider headings; move focus to a visible result instead.
  const option = container.querySelector<HTMLButtonElement>(
    '[data-chat-model-option="example/beta"]',
  )!;
  expect(option.checkVisibility()).toBe(true);
  option.focus();
  expect(document.activeElement).toBe(option);
  update();
  await Promise.resolve();
  expect(document.activeElement).toBe(option);
  expect(search.value).toBe("beta");
  trigger.focus();
  await userEvent.keyboard("1");
  expect(params.onModelSelect).toHaveBeenCalledWith("example/beta", "main", undefined);
});
