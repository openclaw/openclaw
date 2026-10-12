import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { focusChatComposerFromPrintableKeydown } from "../chat-pane-shared.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { focusComposerFromChrome } from "./chat-composer-dom.ts";
import { ChatModelPicker } from "./chat-model-picker.tsx";
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
    modelOptions: ["Alpha", "Beta", "Gamma"].map((label) => ({
      label,
      value: (label === "Gamma" ? "other/" : "example/") + label.toLowerCase(),
      commitValue: (label === "Gamma" ? "other/" : "example/") + label.toLowerCase(),
      provider: label === "Gamma" ? "other" : "example",
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
          ${solidTemplate(ChatModelPicker, params)}
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

it("keeps typing in the filter and preserves focus and query across catalog rerenders", async () => {
  const { search, composer, toggle, params, update, trigger } = mountPicker();
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

it.each(["trigger", "Escape", "outside", "selection"])(
  "resets All models after closing through %s without restricting search",
  async (close) => {
    const { picker, trigger, search, composer, toggle, params, update } = mountPicker();
    params.modelOptions = params.modelOptions.map((option) => ({
      ...option,
      recommended: option.label === "Alpha",
    }));
    update();
    const more = picker.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]")!;
    const rest = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="example/beta"]',
    )!;
    await toggle(() => userEvent.click(trigger));
    expect(more.checkVisibility()).toBe(true);
    expect(rest.checkVisibility()).toBe(false);
    await userEvent.click(more);
    expect(more.checkVisibility()).toBe(false);
    expect(rest.checkVisibility()).toBe(true);
    update();
    await Promise.resolve();
    expect(rest.checkVisibility()).toBe(true);

    if (close === "trigger") {
      await toggle(() => userEvent.click(trigger));
    } else if (close === "Escape") {
      await toggle(() => userEvent.keyboard("{Escape}"));
    } else if (close === "outside") {
      await toggle(() => userEvent.click(composer));
    } else {
      await toggle(() => userEvent.click(rest));
      expect(params.onModelSelect).toHaveBeenCalledWith("example/beta", "main", undefined);
    }
    expect(picker.open).toBe(false);
    update();
    await toggle(() => userEvent.click(trigger));
    expect(more.checkVisibility()).toBe(true);
    expect(rest.checkVisibility()).toBe(false);

    // Search still reaches the collapsed remainder, without expanding it.
    await userEvent.type(search, "beta");
    expect(rest.checkVisibility()).toBe(true);
    expect(more.checkVisibility()).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(picker.open).toBe(true);
    expect(search.value).toBe("");
    expect(more.checkVisibility()).toBe(true);
    expect(rest.checkVisibility()).toBe(false);
  },
);

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

it.each(["trigger", "Escape", "selection"])(
  "retains provider toggles after closing through %s",
  async (close) => {
    const { picker, trigger, search, toggle, update, params } = mountPicker();
    const selectedToggle = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-provider-group="example"] [data-chat-model-provider-toggle]',
    )!;
    const otherToggle = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-provider-group="other"] [data-chat-model-provider-toggle]',
    )!;
    await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
    await userEvent.click(selectedToggle);
    await userEvent.click(otherToggle);
    expect(selectedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(otherToggle.getAttribute("aria-expanded")).toBe("true");
    // Search reveals matching rows temporarily without changing group intent.
    await userEvent.click(search);
    await userEvent.keyboard("beta");
    expect(
      picker.querySelector<HTMLButtonElement>('[data-chat-model-option="example/beta"]')!.hidden,
    ).toBe(false);
    update();
    await Promise.resolve();
    if (close === "trigger") {
      await toggle(() => userEvent.click(trigger));
    } else if (close === "Escape") {
      await userEvent.keyboard("{Escape}");
      await toggle(() => userEvent.keyboard("{Escape}"));
    } else {
      await toggle(() => page.getByText("Beta", { exact: true }).click());
      expect(params.onModelSelect).toHaveBeenCalledWith("example/beta", "main", undefined);
    }
    expect(picker.open).toBe(false);
    expect(search.value).toBe("");
    update();
    await toggle(() => userEvent.click(trigger));
    expect(selectedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(otherToggle.getAttribute("aria-expanded")).toBe("true");
    const hidden = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="example/beta"]',
    )!;
    const visible = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="other/gamma"]',
    )!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.checkVisibility()).toBe(false);
    expect(visible.hidden).toBe(false);
    expect(visible.checkVisibility()).toBe(true);
    trigger.focus();
    await toggle(() => userEvent.keyboard("1"));
    expect(params.onModelSelect).toHaveBeenLastCalledWith("other/gamma", "main", undefined);
  },
);
