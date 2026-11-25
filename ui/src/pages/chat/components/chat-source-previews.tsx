import { For, Show, createSignal, createUniqueId, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../../components/solid/popover.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createLinkFaviconReader, type LinkFaviconFetcher } from "../link-favicon-cache.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

type SourcePreviewsProps = {
  sources: readonly ChatSourcePreview[];
  fetchFavicon?: LinkFaviconFetcher;
};

function SourceCard(props: { source: ChatSourcePreview; fetchFavicon?: LinkFaviconFetcher }) {
  const id = `chat-source-${createUniqueId()}`;
  const [ready, setReady] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const [failedFavicon, setFailedFavicon] = createSignal<string>();
  const favicons = createLinkFaviconReader(() => setRevision((value) => value + 1));
  onSettled(() => {
    setReady(true);
    return () => favicons.dispose();
  });
  const favicon = () => {
    if (!ready()) {
      return null;
    }
    revision();
    const url = props.fetchFavicon
      ? favicons.read(new URL(props.source.url).hostname, props.fetchFavicon)
      : null;
    return url && url !== failedFavicon() ? url : null;
  };
  let popover: PopoverHandle | undefined;
  return (
    <div class="chat-source-strip__item">
      <Popover
        id={id}
        triggerId={`${id}:trigger`}
        triggerClass="chat-source-card"
        triggerAriaLabel={null}
        trigger={
          <>
            <span class="chat-source-card__title">{props.source.title}</span>
            <span class="chat-source-card__domain">
              <span class="chat-source-card__icon" aria-hidden="true">
                <Show when={favicon()} fallback={<Icon name="globe" />}>
                  {(url) => (
                    <img
                      src={url()}
                      width="14"
                      height="14"
                      decoding="async"
                      alt=""
                      onError={() => setFailedFavicon(url())}
                    />
                  )}
                </Show>
              </span>
              {props.source.domain}
            </span>
          </>
        }
        label={props.source.title}
        class="chat-source-popover"
        placement="bottom-start"
        ref={(handle) => {
          popover = handle;
          handle.overlay.surface.dataset.sourceUrl = props.source.url;
        }}
      >
        <section aria-label={props.source.title}>
          <div class="chat-source-popover__header">
            <span class="chat-source-card__domain">{props.source.domain}</span>
            <button
              class="chat-source-popover__close"
              type="button"
              aria-label={t("common.close")}
              onClick={() => popover?.overlay.request(false, "return")}
            >
              <Icon name="x" />
            </button>
          </div>
          <Show
            when={props.source.excerpt}
            fallback={
              <p class="chat-source-popover__unavailable">
                {t("chat.messages.sourcePreviews.unavailable")}
              </p>
            }
          >
            <div class="chat-source-popover__kind">
              {t(
                props.source.excerptKind === "page"
                  ? "chat.messages.sourcePreviews.pageExcerpt"
                  : "chat.messages.sourcePreviews.searchSnippet",
              )}
            </div>
            <p class="chat-source-popover__excerpt">{props.source.excerpt}</p>
          </Show>
          <a
            class="chat-source-popover__open"
            href={props.source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("chat.messages.sourcePreviews.open")}
            <span aria-hidden="true">
              <Icon name="externalLink" />
            </span>
          </a>
        </section>
      </Popover>
    </div>
  );
}

export function ChatSourcePreviews(props: SourcePreviewsProps) {
  return (
    <Show when={props.sources.length > 0}>
      <openclaw-chat-sources>
        <div
          class="chat-source-strip"
          role="group"
          aria-label={t("chat.messages.sourcePreviews.label")}
        >
          <div class="chat-source-strip__label">{t("chat.messages.sourcePreviews.label")}</div>
          <div class="chat-source-strip__cards">
            <For each={props.sources} keyed={(source) => source.url}>
              {(source) => <SourceCard source={source()} fetchFavicon={props.fetchFavicon} />}
            </For>
          </div>
        </div>
      </openclaw-chat-sources>
    </Show>
  );
}
