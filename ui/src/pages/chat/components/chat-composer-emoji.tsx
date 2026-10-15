import { createEffect, For, onCleanup, onSettled, Show } from "solid-js";
import {
  createOverlay,
  findOverlayParent,
  type Overlay,
} from "../../../components/overlay-lifecycle.ts";
import { TextareaTokenAnchor } from "../../../components/textarea-token-anchor.ts";
import "../../../components/solid/overlay.css";
import {
  emojiForShortcode,
  EmojiTargetResolver,
  suggestEmoji,
  type EmojiTarget,
} from "../../../lib/chat/emoji.ts";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import "../../../styles/chat/emoji-menu.css";
import { t } from "../../../lib/reactive/i18n.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import {
  handleComposerMenuKeydown,
  ComposerMenu,
  renderComposerMenuOption,
} from "./chat-composer-menu.tsx";

/** Local editing state; both composer owners keep their existing draft/input pipeline. */
export class ComposerEmojiMenu {
  private target: EmojiTarget | null = null;
  private items: string[] = [];
  private index = 0;
  private dismissed: { value: string; caret: number } | null = null;
  private readonly resolver = new EmojiTargetResolver();
  private inserting = false;
  private acceptedEnter = false;
  private requestUpdate: (() => void) | null = null;
  private readonly anchor = new TextareaTokenAnchor(() => {
    const update = this.requestUpdate;
    this.dismiss(this.textarea);
    update?.();
  });
  private popup: Overlay | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  readonly popupRef = (overlay?: Overlay) => {
    this.popup = overlay ?? null;
    this.syncAnchor();
  };

  private syncAnchor() {
    if (this.popup && this.textarea && this.target && this.open) {
      this.anchor.updateNative(this.popup, this.textarea, this.target.start);
    } else {
      this.anchor.close();
    }
  }

  get open() {
    return this.items.length > 0;
  }
  close() {
    this.acceptedEnter = false;
    this.items = [];
    this.anchor.close();
    this.requestUpdate = null;
    this.textarea = null;
    this.target = null;
    this.index = 0;
    this.dismissed = null;
    this.resolver.reset();
  }
  dismiss(textarea: HTMLTextAreaElement | null) {
    this.close();
    // Overlay dismissal runs before the textarea key handler.
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
      textarea.selectionStart !== textarea.selectionEnd ||
      !event.cancelable
    ) {
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

  handleKeyup(event: KeyboardEvent) {
    if (event.key === "Enter") {
      this.acceptedEnter = false;
    }
  }

  handleKeydown(event: KeyboardEvent, paneId: string, requestUpdate: () => void) {
    if (event.key === "Enter") {
      if (!event.repeat) {
        this.acceptedEnter = false;
      } else if (this.acceptedEnter) {
        event.preventDefault();
        return true;
      }
    }
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
      select: (key) => {
        this.select(textarea, requestUpdate);
        // Keep the accepting press consumed after insertion closes the menu.
        this.acceptedEnter = key === "Enter";
      },
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

  updatePresentation(textarea: HTMLTextAreaElement, requestUpdate: () => void) {
    this.requestUpdate = requestUpdate;
    this.textarea = textarea;
    this.syncAnchor();
  }

  renderOptions(paneId: string, textarea: HTMLTextAreaElement, requestUpdate: () => void) {
    return (
      <For each={this.items} keyed={(name) => name}>
        {(name, index) =>
          renderComposerMenuOption({
            id: paneDomId(paneId, `emoji-option-${index()}`),
            active: index() === this.index,
            select: () => this.select(textarea, requestUpdate, index()),
            hover: () => {
              this.index = index();
              requestUpdate();
            },
            icon: emojiForShortcode(name()),
            iconHidden: true,
            name: `:${name()}:`,
            description: undefined,
          })
        }
      </For>
    );
  }
}

export function EmojiMenu(props: {
  args: [ComposerEmojiMenu, string, HTMLTextAreaElement | null, () => void];
}) {
  const textarea = () => {
    const target = props.args[2];
    return props.args[0].open && target && !target.disabled && !target.readOnly
      ? target
      : undefined;
  };
  return (
    <Show when={textarea()}>
      {(target) => (
        <EmojiPopup
          menu={props.args[0]}
          paneId={props.args[1]}
          textarea={target()}
          requestUpdate={props.args[3]}
          revision={props.args}
        />
      )}
    </Show>
  );
}

function EmojiPopup(props: {
  menu: ComposerEmojiMenu;
  paneId: string;
  textarea: HTMLTextAreaElement;
  requestUpdate: () => void;
  revision: unknown;
}) {
  let surface!: HTMLDivElement;
  const overlay = createOverlay(paneDomId(props.paneId, "emoji-popup"), undefined, {
    acquireOcclusion: acquireNativeOverlaySurface,
    exclusiveGroup: "menu",
    dismissOutsideFocus: false,
  });
  onSettled(() => {
    overlay.bindSurface(surface);
    overlay.setParent(findOverlayParent(props.textarea));
    const unsubscribe = overlay.subscribe((open) => {
      if (!open && props.menu.open) {
        props.menu.dismiss(props.textarea);
        props.requestUpdate();
      }
    });
    props.menu.popupRef(overlay);
    return unsubscribe;
  });
  onCleanup(() => overlay.dispose());
  createEffect(
    () => props.revision,
    () => {
      props.menu.updatePresentation(props.textarea, props.requestUpdate);
    },
  );
  onCleanup(() => props.menu.popupRef());
  const activeId = () => {
    void props.revision;
    return props.menu.activeId(props.paneId) ?? undefined;
  };
  const options = () => {
    void props.revision;
    return props.menu.renderOptions(props.paneId, props.textarea, props.requestUpdate);
  };
  return (
    <div
      ref={(node) => {
        surface = node;
      }}
      class="oc-overlay emoji-menu-popup"
      popover="manual"
    >
      <ComposerMenu
        class="emoji-menu"
        id={paneDomId(props.paneId, "emoji-menu-listbox")}
        label={t("chat.composer.emojiSuggestions")}
        activeId={activeId()}
        revision={props.revision}
      >
        {options()}
      </ComposerMenu>
    </div>
  );
}
