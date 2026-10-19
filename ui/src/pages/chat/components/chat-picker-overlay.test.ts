/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

function registerInvocations(...composers: HTMLElement[]) {
  for (const composer of composers) {
    for (const menu of composer.querySelectorAll<HTMLElement>(".slash-menu, .skill-menu")) {
      onTestFinished(
        registerChatComposerInvocationMenu(menu, () => composer.querySelector("textarea")),
      );
    }
  }
}

describe("chat picker overlay", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("dismisses the tooltip first with the composer listener registered before or after it", async () => {
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const picker = document.createElement("details");
    const trigger = document.createElement("summary");
    const field = document.createElement("input");
    field.value = "Retained choice";
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "Choice details";
    tooltip.anchor = field;
    const surface = document.createElement("div");
    surface.setAttribute("data-anchored-overlay", "");
    surface.setAttribute("popover", "manual");
    surface.append(field, tooltip);
    picker.append(trigger, surface);
    const invocationMenu = document.createElement("div");
    invocationMenu.className = "slash-menu";
    composer.append(picker, invocationMenu);
    document.body.append(composer);
    registerInvocations(composer);
    bindPicker(picker);
    await tooltip.updateComplete;
    const dismissInvocations = vi.fn();
    composer.addEventListener("openclaw-composer-dismiss-invocations", dismissInvocations);

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

      const claimedEscape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      claimedEscape.preventDefault();
      field.dispatchEvent(claimedEscape);
      expect(popup.matches(":popover-open")).toBe(true);
      expect(picker.open).toBe(true);
      expect(dismissInvocations).not.toHaveBeenCalled();

      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(escape);
      await settleTooltip(tooltip);
      expect(popup.matches(":popover-open")).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(picker.open).toBe(true);
      expect(dismissInvocations).not.toHaveBeenCalled();
      expect(field.value).toBe("Retained choice");
      expect(document.activeElement).toBe(field);

      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
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
      const invocationComposer = document.createElement("div");
      invocationComposer.className = "agent-chat__input";
      invocationComposer.innerHTML = '<div class="slash-menu"></div>';
      const nativeComposer = document.createElement("div");
      nativeComposer.className = "agent-chat__input";
      nativeComposer.innerHTML = markup;
      document.body.append(invocationComposer, nativeComposer);
      registerInvocations(invocationComposer, nativeComposer);
      const dismissInvocations = vi.fn();
      invocationComposer.addEventListener(
        "openclaw-composer-dismiss-invocations",
        dismissInvocations,
      );
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

      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(escape);
      expect(surface.matches(":popover-open")).toBe(false);
      expect(picker.hasAttribute("open")).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(trigger);
      expect(dismissInvocations).not.toHaveBeenCalled();

      invocationComposer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(dismissInvocations).toHaveBeenCalledOnce();
    },
  );

  it("lets the native owner clear search before closing and returning focus", () => {
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const picker = document.createElement("details");
    picker.className = "chat-controls__inline-select";
    picker.innerHTML =
      '<summary>Model</summary><div data-anchored-overlay popover="manual"><input data-chat-model-search></div>';
    composer.append(picker);
    document.body.append(composer);
    registerInvocations(composer);
    onTestFinished(installChatComposerPickerDismissal(document));
    bindPicker(picker);
    const trigger = picker.querySelector("summary")!;
    const surface = picker.querySelector<HTMLElement>("[data-anchored-overlay]")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-controls")).toBe(surface.id);
    expect(document.getElementById(surface.getAttribute("aria-labelledby")!)).toBe(trigger);
    expect(surface.getAttribute("role")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));
    const search = picker.querySelector("input")!;
    search.value = "beta";
    search.focus();
    const escape = () =>
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
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
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    composer.innerHTML =
      '<div class="agent-chat__composer-combobox"><textarea></textarea></div><div class="slash-menu"></div>';
    document.body.append(composer);
    registerInvocations(composer);
    const textarea = composer.querySelector("textarea")!;
    textarea.focus();
    const dismissInvocations = vi.fn();
    composer.addEventListener("openclaw-composer-dismiss-invocations", dismissInvocations);

    const modal = document.createElement("openclaw-modal-dialog");
    modal.label = "Keyboard shortcuts";
    modal.innerHTML = "<button>Close</button>";
    document.body.append(modal);
    const { dialog } = await getRenderedModalDialog(document.body);
    expect(dialog.open).toBe(true);
    const modalEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(modalEscape);
    expect(modalEscape.defaultPrevented).toBe(false);
    expect(dismissInvocations).not.toHaveBeenCalled();

    // jsdom does not synthesize the native cancel event from Escape.
    const hidden = afterModalHidden(modal);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await hidden;
    expect(dialog.open).toBe(false);
    const invocationEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
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
      const composer = document.createElement("div");
      composer.className = "agent-chat__input";
      composer.innerHTML = nested
        ? '<div class="agent-chat__composer-combobox"><textarea></textarea><div class="slash-menu"></div></div>'
        : '<div class="agent-chat__composer-combobox"><textarea></textarea></div><div class="slash-menu"></div>';
      document.body.append(composer);
      registerInvocations(composer);
      const dismissInvocations = vi.fn();
      composer.addEventListener("openclaw-composer-dismiss-invocations", dismissInvocations);
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
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      composer.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
      expect(dismissInvocations).toHaveBeenCalledTimes(2);

      onTestFinished(installChatComposerPickerDismissal(document));
      pointerOutside();
      expect(dismissInvocations).toHaveBeenCalledTimes(3);
      const reconnectedEscape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
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
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const picker = document.createElement("details");
    const trigger = document.createElement("summary");
    const search = document.createElement("input");
    search.setAttribute("data-chat-model-search", "true");
    const surface = document.createElement("div");
    surface.setAttribute("data-anchored-overlay", "");
    surface.setAttribute("popover", "manual");
    surface.append(search);
    picker.append(trigger, surface);
    composer.append(picker);
    document.body.append(composer);
    registerInvocations(composer);
    picker.open = true;
    onTestFinished(installChatComposerPickerDismissal(document));
    bindPicker(picker);
    search.focus();

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    search.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(picker.open).toBe(true);
    expect(document.activeElement).toBe(search);

    search.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(picker.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("returns Escape focus to the picker’s own trigger", () => {
    onTestFinished(installChatComposerPickerDismissal(document));
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const settings = document.createElement("div");
    settings.className = "chat-controls__model-settings";
    const modelPicker = document.createElement("details");
    modelPicker.className = "chat-controls__model-picker";
    const modelTrigger = document.createElement("summary");
    modelPicker.append(modelTrigger);
    const effortPicker = document.createElement("details");
    effortPicker.className = "chat-controls__effort-picker";
    const effortTrigger = document.createElement("summary");
    const effortControl = document.createElement("input");
    const effortSurface = document.createElement("div");
    effortSurface.setAttribute("data-anchored-overlay", "");
    effortSurface.setAttribute("popover", "manual");
    effortSurface.append(effortControl);
    effortPicker.append(effortTrigger, effortSurface);
    settings.append(modelPicker, effortPicker);
    composer.append(settings);
    document.body.append(composer);
    registerInvocations(composer);

    effortPicker.open = true;
    bindPicker(effortPicker);
    effortPicker.dispatchEvent(new Event("toggle"));
    effortControl.focus();
    effortControl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(effortPicker.open).toBe(false);
    expect(document.activeElement).toBe(effortTrigger);
  });
});
