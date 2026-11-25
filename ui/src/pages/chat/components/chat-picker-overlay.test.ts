/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { settleTooltip, tooltipSurface } from "../../../components/tooltip.test-support.ts";
import {
  afterModalHidden,
  getRenderedModalDialog,
  installDialogPolyfill,
} from "../../../test-helpers/modal-dialog.ts";
import "../../../components/modal-dialog.tsx";
import {
  createChatPickerOverlay,
  installChatComposerPickerDismissal,
  registerChatComposerInvocationMenu,
} from "./chat-picker-overlay.ts";

function bindPicker(details: HTMLDetailsElement): void {
  const bind = createRoot((dispose) => {
    onTestFinished(dispose);
    return createChatPickerOverlay();
  });
  bind.details(details);
  bind.trigger(details.querySelector("summary")!);
  bind.surface(details.querySelector<HTMLElement>("[data-anchored-overlay]")!);
  details.addEventListener("click", bind.onClick);
  details.addEventListener("toggle", bind.onToggle);
  onTestFinished(() => {
    details.removeEventListener("click", bind.onClick);
    details.removeEventListener("toggle", bind.onToggle);
  });
  flush();
}

function composerWith(markup: string) {
  const composer = document.createElement("div");
  composer.className = "agent-chat__input";
  composer.innerHTML = markup;
  document.body.append(composer);
  for (const menu of composer.querySelectorAll<HTMLElement>(".slash-menu, .skill-menu")) {
    onTestFinished(
      registerChatComposerInvocationMenu(menu, () => composer.querySelector("textarea")),
    );
  }
  return composer;
}

function pickerIn(composer: HTMLElement) {
  const picker = document.createElement("details");
  picker.innerHTML =
    '<summary>Model</summary><div data-anchored-overlay popover="manual"><input data-chat-model-search></div>';
  composer.append(picker);
  return {
    picker,
    trigger: picker.querySelector("summary")!,
    surface: picker.querySelector<HTMLElement>("[data-anchored-overlay]")!,
    search: picker.querySelector("input")!,
  };
}

function escape(target: EventTarget, init: KeyboardEventInit = {}, claimed = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (claimed) {
    event.preventDefault();
  }
  target.dispatchEvent(event);
  return event;
}

function dismissalSpy(composer: HTMLElement) {
  const dismiss = vi.fn();
  composer.addEventListener("openclaw-composer-dismiss-invocations", dismiss);
  return dismiss;
}

afterEach(() => document.body.replaceChildren());

it("dismisses the tooltip first with the composer listener registered before or after it", async () => {
  const composer = composerWith('<div class="slash-menu"></div>');
  const { picker, trigger, surface, search: field } = pickerIn(composer);
  field.value = "Retained choice";
  const tooltip = document.createElement("openclaw-tooltip");
  tooltip.content = "Choice details";
  tooltip.anchor = field;
  field.removeAttribute("data-chat-model-search");
  surface.append(tooltip);
  bindPicker(picker);
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.getAttribute("aria-controls")).toBe(surface.id);
  expect(document.getElementById(surface.getAttribute("aria-labelledby")!)).toBe(trigger);
  expect(surface.getAttribute("role")).toBe("dialog");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await tooltip.updateComplete;
  const dismissInvocations = dismissalSpy(composer);

  // First opening precedes the composer's one-time listener installation.
  // Reopening registers the tooltip after that same composer listener.
  for (let opening = 0; opening < 2; opening += 1) {
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));
    field.focus();
    await settleTooltip(tooltip);
    const popup = tooltipSurface(tooltip)!;
    expect(popup.matches(":popover-open")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    if (opening === 0) {
      onTestFinished(installChatComposerPickerDismissal(document));
    }
    dismissInvocations.mockClear();

    escape(field, {}, true);
    expect(popup.matches(":popover-open")).toBe(true);
    expect(picker.open).toBe(true);
    expect(dismissInvocations).not.toHaveBeenCalled();

    const event = escape(field);
    await settleTooltip(tooltip);
    expect(popup.matches(":popover-open")).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(picker.open).toBe(true);
    expect(dismissInvocations).not.toHaveBeenCalled();
    expect(field.value).toBe("Retained choice");
    expect(document.activeElement).toBe(field);

    escape(field);
    expect(picker.open).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dismissInvocations).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  }
});

it("leaves Escape to an open native modal before dismissing retained invocations", async () => {
  onTestFinished(installDialogPolyfill());
  onTestFinished(installChatComposerPickerDismissal(document));
  const composer = composerWith(
    '<div class="agent-chat__composer-combobox"><textarea></textarea></div><div class="slash-menu"></div>',
  );
  const textarea = composer.querySelector("textarea")!;
  textarea.focus();
  const dismissInvocations = dismissalSpy(composer);

  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Keyboard shortcuts";
  modal.innerHTML = "<button>Close</button>";
  document.body.append(modal);
  const { dialog } = await getRenderedModalDialog(document.body);
  expect(dialog.open).toBe(true);
  expect(escape(dialog).defaultPrevented).toBe(false);
  expect(dismissInvocations).not.toHaveBeenCalled();

  // jsdom does not synthesize the native cancel event from Escape.
  const hidden = afterModalHidden(modal);
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  await hidden;
  expect(dialog.open).toBe(false);
  expect(escape(textarea).defaultPrevented).toBe(true);
  expect(dismissInvocations).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(textarea);
});

it.each([false, true])(
  "shares invocation dismissal until the final owner releases it and can reconnect (nested=%s)",
  (nested) => {
    const releaseFirst = installChatComposerPickerDismissal(document);
    const releaseSecond = installChatComposerPickerDismissal(document);
    onTestFinished(releaseFirst);
    onTestFinished(releaseSecond);
    const composer = composerWith(
      nested
        ? '<div class="agent-chat__composer-combobox"><textarea></textarea><div class="slash-menu"></div></div>'
        : '<div class="agent-chat__composer-combobox"><textarea></textarea></div><div class="slash-menu"></div>',
    );
    const dismissInvocations = dismissalSpy(composer);
    const pointerOutside = () =>
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));

    composer
      .querySelector(".slash-menu")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(dismissInvocations).not.toHaveBeenCalled();
    pointerOutside();
    expect(dismissInvocations).toHaveBeenCalledTimes(1);

    releaseFirst();
    releaseFirst();
    pointerOutside();
    expect(dismissInvocations).toHaveBeenCalledTimes(2);

    releaseSecond();
    pointerOutside();
    expect(escape(composer).defaultPrevented).toBe(false);
    expect(dismissInvocations).toHaveBeenCalledTimes(2);

    onTestFinished(installChatComposerPickerDismissal(document));
    pointerOutside();
    expect(dismissInvocations).toHaveBeenCalledTimes(3);
    expect(escape(composer).defaultPrevented).toBe(true);
    expect(dismissInvocations).toHaveBeenCalledTimes(4);
    expect(document.activeElement).toBe(composer.querySelector("textarea"));
  },
);

it.each([
  { isComposing: true, keyCode: 0 },
  { isComposing: false, keyCode: 229 },
])("leaves empty-search Escape to composition ($isComposing, $keyCode)", (composition) => {
  const composer = composerWith("");
  const { picker, trigger, search } = pickerIn(composer);
  picker.open = true;
  onTestFinished(installChatComposerPickerDismissal(document));
  bindPicker(picker);
  search.focus();

  expect(escape(search, composition).defaultPrevented).toBe(false);
  expect(picker.open).toBe(true);
  expect(document.activeElement).toBe(search);

  escape(search);
  expect(picker.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});
