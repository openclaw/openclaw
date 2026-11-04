import { createStore } from "solid-js";
import type { Overlay } from "../../../components/overlay-lifecycle.ts";
import type { EmojiTarget } from "../../../lib/chat/emoji.ts";
import { createIdleImport } from "../../../lib/idle-import.ts";
import { paneDomId } from "./chat-composer-dom.ts";

export type EmojiMenuState = {
  target: EmojiTarget | null;
  items: string[];
  index: number;
  dismissed: { value: string; caret: number } | null;
};

/** The store exists at boot; the plain editing engine is constructed on first use. */
export function createComposerEmojiMenu() {
  const [state, setState] = createStore<EmojiMenuState>({
    target: null,
    items: [],
    index: 0,
    dismissed: null,
  });
  let engine:
    | ReturnType<typeof import("./chat-composer-emoji-engine.ts").createComposerEmojiEngine>
    | undefined;
  let textarea: HTMLTextAreaElement | null = null;
  let popup: Overlay | undefined;
  let emojiEnabled = true;
  const catalog = createIdleImport(
    // Fetch together: construction must not introduce a serial catalog round trip.
    () =>
      Promise.all([
        import("./chat-composer-emoji-engine.ts"),
        import("../../../lib/chat/emoji.ts"),
      ]),
    ([loaded, emoji]) => {
      engine = loaded.createComposerEmojiEngine(state, setState, emoji);
      engine.popupRef(popup);
      if (textarea) {
        engine.update(textarea, emojiEnabled);
      }
    },
  );

  function close() {
    textarea = null;
    if (engine) {
      engine.close();
    } else {
      setState((draft) => {
        draft.target = null;
        draft.items.length = 0;
        draft.index = 0;
        draft.dismissed = null;
      });
    }
  }

  function dismiss(target: HTMLTextAreaElement | null) {
    close();
    setState((draft) => {
      draft.dismissed = target ? { value: target.value, caret: target.selectionStart } : null;
    });
  }

  function update(target: HTMLTextAreaElement, enabled = true) {
    textarea = target;
    emojiEnabled = enabled;
    if (engine) {
      engine.update(target, enabled);
      return;
    }
    setState((draft) => {
      if (
        draft.dismissed?.caret === target.selectionStart &&
        draft.dismissed.value === target.value
      ) {
        return;
      }
      if (
        enabled &&
        target.isConnected &&
        target.ownerDocument.activeElement === target &&
        !target.disabled &&
        !target.readOnly &&
        target.selectionStart === target.selectionEnd &&
        /:[a-z0-9_+-]+$/u.test(
          target.value.slice(Math.max(0, target.selectionStart - 64), target.selectionStart),
        )
      ) {
        // Optional suggestions never hold or replay a native edit while loading.
        void catalog.load().catch(() => undefined);
      }
    });
  }

  function popupRef(overlay?: Overlay) {
    popup = overlay;
    engine?.popupRef(overlay);
  }

  return {
    get open() {
      return state.items.length > 0;
    },
    state,
    close,
    dismiss,
    update,
    complete: (event: InputEvent, enabled = true) => engine?.complete(event, enabled) ?? false,
    handleKeydown: (event: KeyboardEvent, paneId: string) =>
      engine?.handleKeydown(event, paneId) ?? false,
    handleKeyup: (event: KeyboardEvent) => engine?.handleKeyup(event),
    activeId: (paneId: string) =>
      state.items.length ? paneDomId(paneId, `emoji-option-${state.index}`) : null,
    activeLabel: () => (state.items.length ? `:${state.items[state.index]}:` : ""),
    popupRef,
    dispose() {
      textarea = null;
      popup = undefined;
      catalog.dispose();
      engine?.dispose();
    },
    updatePresentation: (target: HTMLTextAreaElement, start: number | null) =>
      engine?.updatePresentation(target, start),
    select: (target: HTMLTextAreaElement, index: number) => engine?.select(target, index),
    hover(index: number) {
      setState((draft) => {
        draft.index = index;
      });
    },
    emojiForShortcode: (name: string) => engine?.emojiForShortcode(name),
  };
}

export type ComposerEmojiMenu = ReturnType<typeof createComposerEmojiMenu>;
