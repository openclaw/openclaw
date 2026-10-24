import { lazy, Repeat, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { MAX_HUMAN_MENTIONS } from "../../../lib/chat/human-mentions.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import type { HumanMentionMenu, HumanMentionMenuHost } from "./chat-composer-mention-menu-state.ts";
import { ComposerMenu, ComposerMenuLoadingRows } from "./chat-composer-menu.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import "../../../styles/chat/mention-menu.css";

const HumanMentionMenuOptions = lazy(() => import("./chat-composer-mention-menu-options.tsx"), {
  export: "HumanMentionMenuOptions",
});

registerEnglishCatalog(registerChatComposerEnglish);

export function HumanMentionMenuView(props: { args: [HumanMentionMenu, HumanMentionMenuHost] }) {
  const menu = () => props.args[0];
  const host = () => props.args[1];
  const result = () => {
    const search = menu().state.search;
    return search?.kind === "ready" ? search.result : undefined;
  };
  const limited = () => host().getMentions().length >= MAX_HUMAN_MENTIONS;
  const loading = () => menu().state.search?.kind === "loading";
  const error = () => {
    const search = menu().state.search;
    return search?.kind === "error" ? search.reason : null;
  };
  const message = () =>
    limited()
      ? t("chat.mentions.limit")
      : error()
        ? t(`chat.mentions.${error()}`)
        : !loading() && !result()?.users.length
          ? t("chat.mentions.empty")
          : null;
  return (
    <Show when={menu().open}>
      <ComposerMenu
        id={paneDomId(host().paneId, "mention-menu-listbox")}
        class="mention-menu"
        label={t("chat.mentions.menu")}
        trackScroll={false}
        activeId={menu().activeId(host().paneId)}
        revision={menu().state.search}
      >
        <div class="slash-menu-group" aria-busy={loading() ? "true" : "false"}>
          <div class="slash-menu-group__label" role="status">
            {message() ?? t("chat.mentions.menu")}
          </div>
          <Show when={error() === "unavailable" && !limited()}>
            <button
              type="button"
              class="btn btn--sm mention-menu__retry"
              onClick={() => {
                menu().retry();
                host().getTextarea()?.focus({ preventScroll: true });
              }}
            >
              {t("common.retry")}
            </button>
          </Show>
          <Show when={!message() && !loading()}>
            <ChatLazyBoundary
              fallback={
                <ComposerMenuLoadingRows
                  activeId={menu().activeId(host().paneId)}
                  rows={
                    result()?.users.map((person, index) => ({
                      id: paneDomId(host().paneId, `mention-option-${index}`),
                      name: person.displayName,
                      description: person.online ? t("chat.mentions.online") : undefined,
                      select: () => menu().select(person, host()),
                      hover: () => menu().hover(index, person.profileId),
                    })) ?? []
                  }
                />
              }
              onClose={() => menu().close()}
            >
              <HumanMentionMenuOptions args={props.args} />
            </ChatLazyBoundary>
          </Show>
          <Show when={!message() && loading()}>
            <Repeat count={3}>
              {() => (
                <div class="slash-menu-item mention-menu__loading" aria-hidden="true">
                  <span class="slash-menu-icon">
                    <span class="skeleton mention-menu__avatar" />
                  </span>
                  <span class="skeleton skeleton-line skeleton-line--medium" />
                </div>
              )}
            </Repeat>
          </Show>
          <Show when={result()?.truncated}>
            <div class="slash-menu-group__label">{t("chat.mentions.truncated")}</div>
          </Show>
        </div>
      </ComposerMenu>
    </Show>
  );
}
