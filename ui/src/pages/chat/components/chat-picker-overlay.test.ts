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
import { settleWebAwesome } from "../../../test-helpers/web-awesome.ts";
import "../../../components/modal-dialog.ts";
import { closeChatPaneDetails } from "../chat-pane-shared.ts";
import {
  createChatPickerOverlay,
  installChatComposerPickerDismissal,
  handleChatComposerDropdownShow,
  markPointerOpenedChatComposerDropdown,
  restorePointerOpenedChatComposerTrigger,
} from "./chat-picker-overlay.ts";

function bindPicker(details: HTMLDetailsElement): void {
  const bind = createRoot((dispose) => {
    onTestFinished(dispose);
    return createChatPickerOverlay();
  });
  bind(details);
  flush();
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
    picker.append(trigger, field, tooltip);
    const invocationMenu = document.createElement("div");
    invocationMenu.className = "slash-menu";
    composer.append(picker, invocationMenu);
    document.body.append(composer);
    await tooltip.updateComplete;
    const dismissInvocations = vi.fn();
    composer.addEventListener("openclaw-composer-dismiss-invocations", dismissInvocations);

    // First opening precedes the composer's one-time listener installation.
    // Reopening registers the tooltip after that same composer listener.
    for (let opening = 0; opening < 2; opening += 1) {
      picker.open = true;
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
      expect(dismissInvocations).toHaveBeenCalledOnce();
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
      const dismissInvocations = vi.fn();
      invocationComposer.addEventListener(
        "openclaw-composer-dismiss-invocations",
        dismissInvocations,
      );
      const dismissPaneDetails = (event: KeyboardEvent) => {
        if (
          !event.defaultPrevented &&
          event.key === "Escape" &&
          closeChatPaneDetails(nativeComposer)
        ) {
          event.preventDefault();
        }
      };
      document.addEventListener("keydown", dismissPaneDetails, true);
      onTestFinished(() => document.removeEventListener("keydown", dismissPaneDetails, true));
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
    const dismissLegacyDetails = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        event.key === "Escape" &&
        closeChatPaneDetails(composer)
      ) {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", dismissLegacyDetails, true);
    onTestFinished(() => document.removeEventListener("keydown", dismissLegacyDetails, true));
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

  it("shares dismissal until the final owner releases it and can reconnect", () => {
    const releaseFirst = installChatComposerPickerDismissal(document);
    const releaseSecond = installChatComposerPickerDismissal(document);
    onTestFinished(releaseFirst);
    onTestFinished(releaseSecond);
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const picker = document.createElement("details");
    const menu = document.createElement("div");
    menu.className = "slash-menu";
    composer.append(picker, menu);
    document.body.append(composer);
    const dismissInvocations = vi.fn();
    composer.addEventListener("openclaw-composer-dismiss-invocations", dismissInvocations);
    const pointerOutside = () =>
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));

    picker.open = true;
    pointerOutside();
    expect(picker.open).toBe(false);
    expect(dismissInvocations).toHaveBeenCalledTimes(1);

    releaseFirst();
    releaseFirst();
    picker.open = true;
    pointerOutside();
    expect(picker.open).toBe(false);
    expect(dismissInvocations).toHaveBeenCalledTimes(2);

    releaseSecond();
    picker.open = true;
    pointerOutside();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(escape);
    expect(picker.open).toBe(true);
    expect(escape.defaultPrevented).toBe(false);
    expect(dismissInvocations).toHaveBeenCalledTimes(2);

    onTestFinished(installChatComposerPickerDismissal(document));
    pointerOutside();
    expect(picker.open).toBe(false);
    expect(dismissInvocations).toHaveBeenCalledTimes(3);
  });

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
    picker.append(trigger, search);
    composer.append(picker);
    document.body.append(composer);
    picker.open = true;
    onTestFinished(installChatComposerPickerDismissal(document));
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

  it("does not restore pointer focus after keyboard input takes over", () => {
    onTestFinished(installChatComposerPickerDismissal(document));
    const dropdown = document.createElement("wa-dropdown");
    const trigger = document.createElement("button");
    trigger.slot = "trigger";
    dropdown.append(trigger);
    document.body.append(dropdown);

    dropdown.addEventListener("wa-show", handleChatComposerDropdownShow);
    dropdown.dispatchEvent(new Event("wa-show"));
    dropdown.addEventListener("pointerdown", markPointerOpenedChatComposerDropdown);
    trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));

    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "Enter" }),
    );

    dropdown.addEventListener("wa-after-show", restorePointerOpenedChatComposerTrigger);
    dropdown.dispatchEvent(new Event("wa-after-show"));

    expect(trigger.hasAttribute("data-chat-pointer-restored-focus")).toBe(false);
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

    effortPicker.open = true;
    bindPicker(effortPicker);
    effortPicker.dispatchEvent(new Event("toggle"));
    effortControl.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(effortPicker.open).toBe(false);
    expect(document.activeElement).toBe(effortTrigger);
  });

  it("keeps ancestor pickers open and dismisses nested menus from the inside out", async () => {
    onTestFinished(installChatComposerPickerDismissal(document));
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const model = document.createElement("details");
    const modelTrigger = document.createElement("summary");
    const dropdown = document.createElement("wa-dropdown");
    const accountTrigger = document.createElement("button");
    accountTrigger.slot = "trigger";
    dropdown.append(accountTrigger);
    model.append(modelTrigger, dropdown);
    const peer = document.createElement("details");
    composer.append(model, peer);
    document.body.append(composer);
    model.open = peer.open = true;
    dropdown.setAttribute("open", "");
    dropdown.addEventListener("wa-show", handleChatComposerDropdownShow);
    dropdown.dispatchEvent(new Event("wa-show"));

    await settleWebAwesome(composer);
    expect(model.open).toBe(true);
    expect(peer.open).toBe(false);
    accountTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.hasAttribute("open")).toBe(false);
    expect(model.open).toBe(true);
    expect(document.activeElement).toBe(accountTrigger);

    accountTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(model.open).toBe(false);
    expect(document.activeElement).toBe(modelTrigger);
  });
});
