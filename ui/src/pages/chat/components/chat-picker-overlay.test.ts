/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createOverlay } from "../../../components/overlay-lifecycle.ts";
import { settleTooltip, tooltipSurface } from "../../../components/tooltip.test-support.ts";
import {
  afterModalHidden,
  getRenderedModalDialog,
  installDialogPolyfill,
} from "../../../test-helpers/modal-dialog.ts";
import "../../../components/modal-dialog.ts";
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

function escapeEvent(init: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
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
    if (opening === 0) {
      onTestFinished(installChatComposerPickerDismissal(document));
    }
    dismissInvocations.mockClear();

    const claimedEscape = escapeEvent();
    claimedEscape.preventDefault();
    field.dispatchEvent(claimedEscape);
    expect(popup.matches(":popover-open")).toBe(true);
    expect(picker.open).toBe(true);
    expect(dismissInvocations).not.toHaveBeenCalled();

    const escape = escapeEvent();
    field.dispatchEvent(escape);
    await settleTooltip(tooltip);
    expect(popup.matches(":popover-open")).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(picker.open).toBe(true);
    expect(dismissInvocations).not.toHaveBeenCalled();
    expect(field.value).toBe("Retained choice");
    expect(document.activeElement).toBe(field);

    field.dispatchEvent(escapeEvent());
    expect(picker.open).toBe(false);
    expect(dismissInvocations).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  }
});

it.each([
  [
    "context",
    '<div class="context-usage"><details data-picker data-chat-native-picker><summary>Context</summary><div popover="manual"><input></div></details></div>',
  ],
  [
    "Plus",
    '<div class="agent-chat__attach-menu" data-picker><button>Plus</button><div popover="manual"><input></div></div>',
  ],
  [
    "emoji",
    '<button>Emoji</button><div class="emoji-menu-popup" data-picker popover="manual"><input></div>',
  ],
])(
  "leaves %s Escape to its native owner before another composer's invocation menu",
  (_, markup) => {
    const invocationComposer = composerWith('<div class="slash-menu"></div>');
    const nativeComposer = composerWith(markup);
    const dismissInvocations = dismissalSpy(invocationComposer);
    onTestFinished(installChatComposerPickerDismissal(document));
    const surface = nativeComposer.querySelector<HTMLElement>("[popover]")!;
    const trigger = nativeComposer.querySelector<HTMLElement>("summary, button")!;
    const picker = nativeComposer.querySelector<HTMLElement>("[data-picker]")!;
    const overlay = createOverlay("composer-escape-test");
    onTestFinished(() => overlay.dispose());
    overlay.bindSurface(surface);
    overlay.bindTrigger(trigger);
    overlay.subscribe((open) => picker.toggleAttribute("open", open));
    expect(overlay.request(true)).toBe(true);
    const field = surface.querySelector("input")!;
    field.focus();

    const escape = escapeEvent();
    field.dispatchEvent(escape);
    expect(surface.matches(":popover-open")).toBe(false);
    expect(picker.hasAttribute("open")).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(dismissInvocations).not.toHaveBeenCalled();

    invocationComposer.dispatchEvent(escapeEvent());
    expect(dismissInvocations).toHaveBeenCalledOnce();
  },
);

it("lets the native owner clear search before closing and returning focus", () => {
  const composer = composerWith(
    '<div class="chat-controls__model-settings"><details class="chat-controls__model-picker"><summary>Model</summary></details></div>',
  );
  const { picker, trigger, surface, search } = pickerIn(
    composer.querySelector<HTMLElement>(".chat-controls__model-settings")!,
  );
  picker.className = "chat-controls__inline-select chat-controls__effort-picker";
  onTestFinished(installChatComposerPickerDismissal(document));
  bindPicker(picker);
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.getAttribute("aria-controls")).toBe(surface.id);
  expect(document.getElementById(surface.getAttribute("aria-labelledby")!)).toBe(trigger);
  expect(surface.getAttribute("role")).toBe("dialog");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  picker.open = true;
  picker.dispatchEvent(new Event("toggle"));
  search.value = "beta";
  search.focus();
  const escape = () => search.dispatchEvent(escapeEvent());
  escape();
  expect(search.value).toBe("");
  expect(picker.open).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(search);
  escape();
  expect(picker.open).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
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
  const modalEscape = escapeEvent();
  dialog.dispatchEvent(modalEscape);
  expect(modalEscape.defaultPrevented).toBe(false);
  expect(dismissInvocations).not.toHaveBeenCalled();

  // jsdom does not synthesize the native cancel event from Escape.
  const hidden = afterModalHidden(modal);
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  await hidden;
  expect(dialog.open).toBe(false);
  const invocationEscape = escapeEvent();
  textarea.dispatchEvent(invocationEscape);
  expect(invocationEscape.defaultPrevented).toBe(true);
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
    const escape = escapeEvent();
    composer.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(dismissInvocations).toHaveBeenCalledTimes(2);

    onTestFinished(installChatComposerPickerDismissal(document));
    pointerOutside();
    expect(dismissInvocations).toHaveBeenCalledTimes(3);
    const reconnectedEscape = escapeEvent();
    composer.dispatchEvent(reconnectedEscape);
    expect(reconnectedEscape.defaultPrevented).toBe(true);
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

  const escape = escapeEvent(composition);
  search.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  expect(picker.open).toBe(true);
  expect(document.activeElement).toBe(search);

  search.dispatchEvent(escapeEvent());
  expect(picker.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});
