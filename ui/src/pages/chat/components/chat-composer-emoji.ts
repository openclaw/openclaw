import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import {
  handleComposerMenuKeydown,
  renderComposerMenu,
  renderComposerMenuOption,
} from "../../../components/composer-menu.ts";
import "../../../styles/chat/emoji-menu.css";
import { TextareaTokenAnchor } from "../../../components/textarea-token-anchor.ts";
import { t } from "../../../i18n/index.ts";
import {
  emojiForShortcode,
  EmojiTargetResolver,
  suggestEmoji,
  type EmojiTarget,
} from "../../../lib/chat/emoji.ts";
import { paneDomId } from "./chat-composer-dom.ts";

/** Local editing state; both composer owners keep their existing draft/input pipeline. */
export class ComposerEmojiMenu {
  private target: EmojiTarget | null = null;
  private items: string[] = [];
  private index = 0;
  private dismissed: { value: string; caret: number } | null = null;
  private readonly resolver = new EmojiTargetResolver();
  private inserting = false;
  private requestUpdate: (() => void) | null = null;
  private readonly anchor = new TextareaTokenAnchor(() => {
    const update = this.requestUpdate;
    this.dismiss(this.textarea);
    update?.();
  });
  private popup: WaPopup | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private readonly popupRef = (element?: Element) => {
    this.popup = element instanceof WaPopup ? element : null;
    this.syncAnchor();
  };

  private syncAnchor() {
    if (this.popup && this.textarea && this.target && this.open) {
      this.anchor.update(this.popup, this.textarea, this.target.start);
    } else {
      this.anchor.close();
    }
  }

  get open() {
    return this.items.length > 0;
  }
  close() {
    this.anchor.close();
    this.requestUpdate = null;
    this.textarea = null;
    this.target = null;
    this.items = [];
    this.index = 0;
    this.dismissed = null;
    this.resolver.reset();
  }
  dismiss(textarea: HTMLTextAreaElement | null) {
    this.close();
    // Window-level picker dismissal runs before the textarea key handler.
    this.dismissed = textarea ? { value: textarea.value, caret: textarea.selectionStart } : null;
  }
  activeId(paneId: string) {
    return this.open ? paneDomId(paneId, `emoji-option-${this.index}`) : null;
  }
  activeLabel() {
    return this.open ? `:${this.items[this.index]}:` : "";
  }

  update(target: HTMLTextAreaElement, requestUpdate: () => void, enabled = true) {
    if (
      this.dismissed &&
      this.dismissed.caret === target.selectionStart &&
      this.dismissed.value === target.value
    ) {
      return;
    }
    const next =
      enabled &&
      target.isConnected &&
      target.ownerDocument.activeElement === target &&
      !target.disabled &&
      !target.readOnly &&
      target.selectionStart === target.selectionEnd
        ? this.resolver.find(target.value, target.selectionStart)
        : null;
    if (
      next?.start === this.target?.start &&
      next?.query === this.target?.query &&
      next?.end === this.target?.end
    ) {
      if (next) {
        this.syncAnchor();
      }
      return;
    }
    const wasOpen = this.open;
    this.target = next;
    this.items = next ? suggestEmoji(next.query) : [];
    this.index = 0;
    this.dismissed = null;
    if (wasOpen || this.open) {
      requestUpdate();
    }
  }

  private insert(
    textarea: HTMLTextAreaElement,
    target: EmojiTarget,
    emoji: string,
    requestUpdate: () => void,
  ) {
    if (textarea.disabled || textarea.readOnly || this.inserting) {
      return false;
    }
    textarea.focus({ preventScroll: true });
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    this.inserting = true;
    this.close();
    textarea.setSelectionRange(target.start, target.end);
    // Unlike value/setRangeText, the browser editing command records an undoable
    // replacement. Its input event goes through the host's canonical draft owner.
    let inserted = false;
    try {
      inserted = textarea.ownerDocument.execCommand?.("insertText", false, emoji) ?? false;
    } finally {
      this.inserting = false;
    }
    if (!inserted) {
      textarea.setSelectionRange(start, end);
    }
    requestUpdate();
    return inserted;
  }

  complete(event: InputEvent, requestUpdate: () => void, enabled = true): boolean {
    const textarea = event.target;
    if (
      !enabled ||
      this.inserting ||
      event.isComposing ||
      event.inputType !== "insertText" ||
      event.data !== ":" ||
      !(textarea instanceof HTMLTextAreaElement) ||
      textarea.selectionStart !== textarea.selectionEnd
    ) {
      return false;
    }
    if (!event.cancelable) {
      return false;
    }
    const caret = textarea.selectionStart;
    const target = this.resolver.find(textarea.value, caret);
    const emoji = target && emojiForShortcode(target.query);
    if (
      !target ||
      !emoji ||
      !this.insert(textarea, { ...target, end: caret }, emoji, requestUpdate)
    ) {
      return false;
    }
    event.preventDefault();
    return true;
  }

  handleKeydown(event: KeyboardEvent, paneId: string, requestUpdate: () => void) {
    const textarea = event.target;
    if (
      !this.open ||
      !(textarea instanceof HTMLTextAreaElement) ||
      textarea.disabled ||
      textarea.readOnly ||
      textarea.selectionStart !== textarea.selectionEnd ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return false;
    }
    return handleComposerMenuKeydown(event, {
      count: this.items.length,
      index: this.index,
      consumeEmpty: false,
      close: () => {
        this.dismiss(textarea);
        requestUpdate();
      },
      move: (index) => {
        this.index = index;
        requestUpdate();
        return this.activeId(paneId);
      },
      select: () => this.select(textarea, requestUpdate),
    });
  }

  private select(textarea: HTMLTextAreaElement, requestUpdate: () => void, index = this.index) {
    const target = this.resolver.find(textarea.value, textarea.selectionStart);
    const emoji = emojiForShortcode(this.items[index] ?? "");
    if (
      !target ||
      !emoji ||
      target.start !== this.target?.start ||
      target.query !== this.target.query
    ) {
      return;
    }
    this.insert(textarea, target, emoji, requestUpdate);
  }

  render(paneId: string, textarea: HTMLTextAreaElement | null, requestUpdate: () => void) {
    if (!this.open || !textarea || textarea.disabled || textarea.readOnly) {
      return nothing;
    }
    this.requestUpdate = requestUpdate;
    this.textarea = textarea;
    this.syncAnchor();
    const menu = renderComposerMenu({
      className: "emoji-menu",
      id: paneDomId(paneId, "emoji-menu-listbox"),
      label: t("chat.composer.emojiSuggestions"),
      content: this.items.map((name, index) =>
        renderComposerMenuOption({
          id: paneDomId(paneId, `emoji-option-${index}`),
          active: index === this.index,
          select: () => this.select(textarea, requestUpdate, index),
          hover: () => {
            this.index = index;
            requestUpdate();
          },
          icon: emojiForShortcode(name),
          iconHidden: true,
          name: `:${name}:`,
          description: nothing,
        }),
      ),
    });
    return html`<wa-popup ${ref(this.popupRef)} class="emoji-menu-popup">${menu}</wa-popup>`;
  }
}
