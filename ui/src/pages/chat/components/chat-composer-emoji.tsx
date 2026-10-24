import { createStore, For, onSettled, Show } from "solid-js";
import {
  createOverlay,
  findOverlayParent,
  type Overlay,
} from "../../../components/overlay-lifecycle.ts";
import { createTextareaTokenAnchor } from "../../../components/textarea-token-anchor.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import "../../../components/solid/overlay.css";
import type { EmojiTarget, EmojiTargetResolver } from "../../../lib/chat/emoji.ts";
import { createIdleImport } from "../../../lib/idle-import.ts";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import "../../../styles/chat/emoji-menu.css";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import {
  handleComposerMenuKeydown,
  ComposerMenu,
  renderComposerMenuOption as ComposerMenuOption,
} from "./chat-composer-menu.tsx";

registerEnglishCatalog(registerChatComposerEnglish);

type EmojiMenuState = {
  target: EmojiTarget | null;
  items: string[];
  index: number;
  dismissed: { value: string; caret: number } | null;
};

/** Local editing state; both composer owners keep their existing draft/input pipeline. */
export function createComposerEmojiMenu() {
  const [state, setState] = createStore<EmojiMenuState>({
    target: null,
    items: [],
    index: 0,
    dismissed: null,
  });
  let emoji: typeof import("../../../lib/chat/emoji.ts") | undefined;
  let resolver: EmojiTargetResolver | undefined;
  let emojiEnabled = true;
  // These guards cover synchronous native editing events, before Solid commits.
  let inserting = false;
  let acceptedEnter = false;
  let popup: Overlay | null = null;
  let unsubscribePopup: (() => void) | undefined;
  let textarea: HTMLTextAreaElement | null = null;
  const anchor = createTextareaTokenAnchor(() => dismiss(textarea));
  const catalog = createIdleImport(
    () => import("../../../lib/chat/emoji.ts"),
    (loaded) => {
      emoji = loaded;
      resolver = new loaded.EmojiTargetResolver();
      // Read the current draft and caret; never replay an edit made while loading.
      if (textarea) {
        update(textarea, emojiEnabled);
      }
    },
  );

  function updatePresentation(target: HTMLTextAreaElement, start: number | null) {
    textarea = target;
    if (popup && start !== null) {
      anchor.updateNative(popup, target, start);
    } else {
      anchor.close();
    }
  }

  function popupRef(overlay?: Overlay) {
    unsubscribePopup?.();
    popup = overlay ?? null;
    // A close edge dismisses the editing target even if the overlay reopens before rendering.
    unsubscribePopup = popup?.subscribe((open) => {
      if (!open && state.items.length) {
        dismiss(textarea);
      }
    });
    if (!popup) {
      anchor.close();
    }
  }

  function reset(draft: EmojiMenuState) {
    acceptedEnter = false;
    draft.items.length = 0;
    draft.target = null;
    draft.index = 0;
    draft.dismissed = null;
    resolver?.reset();
    // Overlay retirement notifies synchronously; it must see the closed draft.
    anchor.close();
    textarea = null;
  }

  function close() {
    setState(reset);
  }

  function dismiss(target: HTMLTextAreaElement | null) {
    close();
    // Overlay dismissal runs before the textarea key handler.
    setState((draft) => {
      draft.dismissed = target ? { value: target.value, caret: target.selectionStart } : null;
    });
  }

  function update(target: HTMLTextAreaElement, enabled = true) {
    emojiEnabled = enabled;
    setState((draft) => {
      if (
        draft.dismissed?.caret === target.selectionStart &&
        draft.dismissed.value === target.value
      ) {
        return;
      }
      const eligible =
        enabled &&
        target.isConnected &&
        target.ownerDocument.activeElement === target &&
        !target.disabled &&
        !target.readOnly &&
        target.selectionStart === target.selectionEnd;
      if (
        eligible &&
        !emoji &&
        /:[a-z0-9_+-]+$/u.test(
          target.value.slice(Math.max(0, target.selectionStart - 64), target.selectionStart),
        )
      ) {
        textarea = target;
        // Emoji is optional: native typing continues and a later input retries a failed import.
        void catalog.load().catch(() => undefined);
      }
      const next = eligible ? (resolver?.find(target.value, target.selectionStart) ?? null) : null;
      if (
        next?.start === draft.target?.start &&
        next?.query === draft.target?.query &&
        next?.end === draft.target?.end
      ) {
        if (next) {
          updatePresentation(target, next.start);
        }
        return;
      }
      draft.target = next;
      draft.items = next ? emoji!.suggestEmoji(next.query) : [];
      draft.index = 0;
      draft.dismissed = null;
      updatePresentation(target, next?.start ?? null);
    });
  }

  function insert(target: HTMLTextAreaElement, token: EmojiTarget, replacement: string) {
    if (target.disabled || target.readOnly || inserting) {
      return false;
    }
    target.focus({ preventScroll: true });
    const start = target.selectionStart;
    const end = target.selectionEnd;
    inserting = true;
    close();
    target.setSelectionRange(token.start, token.end);
    // The browser editing command records undo and sends input through the draft owner.
    let inserted = false;
    try {
      inserted = target.ownerDocument.execCommand?.("insertText", false, replacement) ?? false;
    } finally {
      inserting = false;
    }
    if (!inserted) {
      target.setSelectionRange(start, end);
    }
    return inserted;
  }

  function complete(event: InputEvent, enabled = true): boolean {
    const target = event.target;
    if (
      !enabled ||
      !emoji ||
      inserting ||
      event.isComposing ||
      event.inputType !== "insertText" ||
      event.data !== ":" ||
      !(target instanceof HTMLTextAreaElement) ||
      target.selectionStart !== target.selectionEnd ||
      !event.cancelable
    ) {
      return false;
    }
    const caret = target.selectionStart;
    const token = resolver?.find(target.value, caret);
    const replacement = token && emoji.emojiForShortcode(token.query);
    if (!token || !replacement || !insert(target, { ...token, end: caret }, replacement)) {
      return false;
    }
    event.preventDefault();
    return true;
  }

  function selection(target: HTMLTextAreaElement, draft: EmojiMenuState, index = draft.index) {
    const token = resolver?.find(target.value, target.selectionStart);
    const replacement = emoji?.emojiForShortcode(draft.items[index] ?? "");
    return token &&
      replacement &&
      token.start === draft.target?.start &&
      token.query === draft.target.query
      ? { token, emoji: replacement }
      : null;
  }

  function select(target: HTMLTextAreaElement, index: number) {
    const chosen: { value: ReturnType<typeof selection> } = { value: null };
    setState((draft) => {
      chosen.value = selection(target, draft, index);
    });
    if (chosen.value) {
      insert(target, chosen.value.token, chosen.value.emoji);
    }
  }

  function handleKeydown(event: KeyboardEvent, paneId: string) {
    if (event.key === "Enter") {
      if (!event.repeat) {
        acceptedEnter = false;
      } else if (acceptedEnter) {
        event.preventDefault();
        return true;
      }
    }
    const target = event.target;
    if (
      !(target instanceof HTMLTextAreaElement) ||
      target.disabled ||
      target.readOnly ||
      target.selectionStart !== target.selectionEnd ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return false;
    }
    let handled = false;
    const chosen: { value: ReturnType<typeof selection> } = { value: null };
    setState((draft) => {
      if (!draft.items.length) {
        return;
      }
      handled = handleComposerMenuKeydown(event, {
        count: draft.items.length,
        index: draft.index,
        consumeEmpty: false,
        close: () => {
          reset(draft);
          draft.dismissed = { value: target.value, caret: target.selectionStart };
        },
        move: (index) => {
          draft.index = index;
          return paneDomId(paneId, `emoji-option-${index}`);
        },
        select: () => {
          chosen.value = selection(target, draft);
        },
      });
    });
    if (chosen.value) {
      insert(target, chosen.value.token, chosen.value.emoji);
    }
    // Keep the accepting press consumed after insertion closes the menu.
    if (handled) {
      acceptedEnter = event.key === "Enter";
    }
    return handled;
  }

  return {
    get open() {
      return state.items.length > 0;
    },
    state,
    close,
    dismiss,
    update,
    complete,
    handleKeydown,
    handleKeyup(event: KeyboardEvent) {
      if (event.key === "Enter") {
        acceptedEnter = false;
      }
    },
    activeId(paneId: string) {
      return state.items.length ? paneDomId(paneId, `emoji-option-${state.index}`) : null;
    },
    activeLabel: () => (state.items.length ? `:${state.items[state.index]}:` : ""),
    popupRef,
    dispose() {
      // Retire the native target without publishing state from the disposed view.
      textarea = null;
      catalog.dispose();
      popupRef();
    },
    updatePresentation,
    renderOptions(paneId: string, target: HTMLTextAreaElement) {
      return (
        <For each={state.items} keyed={(name) => name}>
          {(name, index) => (
            <ComposerMenuOption
              id={paneDomId(paneId, `emoji-option-${index()}`)}
              active={index() === state.index}
              select={() => select(target, index())}
              hover={() =>
                setState((draft) => {
                  draft.index = index();
                })
              }
              icon={emoji?.emojiForShortcode(name())}
              iconHidden={true}
              name={`:${name()}:`}
              description={undefined}
            />
          )}
        </For>
      );
    },
  };
}

export type ComposerEmojiMenu = ReturnType<typeof createComposerEmojiMenu>;

export function EmojiMenu(props: {
  args: [ComposerEmojiMenu, string, HTMLTextAreaElement | null];
}) {
  const textarea = () => {
    const target = props.args[2];
    return props.args[0].open && target && !target.disabled && !target.readOnly
      ? target
      : undefined;
  };
  return (
    <Show when={textarea()}>
      {(target) => <EmojiPopup menu={props.args[0]} paneId={props.args[1]} textarea={target()} />}
    </Show>
  );
}

function EmojiPopup(props: {
  menu: ComposerEmojiMenu;
  paneId: string;
  textarea: HTMLTextAreaElement;
}) {
  let surface!: HTMLDivElement;
  onSettled(() => {
    const menu = props.menu;
    const target = props.textarea;
    const overlay = createOverlay(paneDomId(props.paneId, "emoji-popup"), undefined, {
      acquireOcclusion: acquireNativeOverlaySurface,
      exclusiveGroup: "menu",
      dismissOutsideFocus: false,
    });
    overlay.bindSurface(surface);
    overlay.setParent(findOverlayParent(target));
    menu.popupRef(overlay);
    menu.updatePresentation(target, menu.state.target?.start ?? null);
    return () => {
      menu.popupRef();
      overlay.dispose();
    };
  });
  return (
    <div ref={(node) => (surface = node)} class="oc-overlay emoji-menu-popup" popover="manual">
      <ComposerMenu
        class="emoji-menu"
        id={paneDomId(props.paneId, "emoji-menu-listbox")}
        label={t("chat.composer.emojiSuggestions")}
        activeId={props.menu.activeId(props.paneId)}
        revision={props.menu.state.items}
      >
        {props.menu.renderOptions(props.paneId, props.textarea)}
      </ComposerMenu>
    </div>
  );
}
