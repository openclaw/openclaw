import { lazy, onSettled, Show } from "solid-js";
import { createOverlay, findOverlayParent } from "../../../components/overlay-lifecycle.ts";
import "../../../components/solid/overlay.css";
import "../../../styles/chat/emoji-menu.css";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { warmWhenIdle } from "../../../lib/idle-warmup.ts";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import type { ComposerEmojiMenu } from "./chat-composer-emoji-state.ts";
import { ComposerMenu, ComposerMenuLoadingRows } from "./chat-composer-menu.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const EmojiMenuOptions = lazy(() => import("./chat-composer-emoji-options.tsx"), {
  export: "EmojiMenuOptions",
});
warmWhenIdle(EmojiMenuOptions.preload);

registerEnglishCatalog(registerChatComposerEnglish);

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
        <ChatLazyBoundary
          fallback={
            <ComposerMenuLoadingRows
              activeId={props.menu.activeId(props.paneId)}
              rows={props.menu.state.items.map((name, index) => ({
                id: paneDomId(props.paneId, `emoji-option-${index}`),
                name: `:${name}:`,
                select: () => props.menu.select(props.textarea, index),
                hover: () => props.menu.hover(index),
              }))}
            />
          }
          onClose={() => props.menu.close()}
        >
          <EmojiMenuOptions menu={props.menu} paneId={props.paneId} textarea={props.textarea} />
        </ChatLazyBoundary>
      </ComposerMenu>
    </div>
  );
}
