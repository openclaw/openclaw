import { For, Show, createSignal, createUniqueId, onCleanup } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../../components/solid/popover.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { readLinkFavicon, type LinkFaviconFetcher } from "../link-favicon-cache.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

type SourcePreviewsProps = {
  sources: readonly ChatSourcePreview[];
  fetchFavicon?: LinkFaviconFetcher;
};

function SourceCard(props: {
  source: ChatSourcePreview;
  favicon: string | null;
  onImageError: (url: string) => void;
}) {
  const id = `chat-source-${createUniqueId()}`;
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  let popover: PopoverHandle | undefined;
  return (
    <div class="chat-source-strip__item">
      <button
        ref={setAnchor}
        id={`${id}:trigger`}
        class="chat-source-card"
        type="button"
        aria-haspopup="dialog"
        aria-controls={id}
        aria-expanded="false"
        onClick={() => popover?.overlay.request(!popover.overlay.open)}
      >
        <span class="chat-source-card__title">{props.source.title}</span>
        <span class="chat-source-card__domain">
          <span class="chat-source-card__icon" aria-hidden="true">
            <Show when={props.favicon} fallback={<Icon name="globe" />}>
              {(url) => <img src={url()} alt="" onError={() => props.onImageError(url())} />}
            </Show>
          </span>
          {props.source.domain}
        </span>
      </button>
      <Show when={anchor()}>
        {(button) => (
          <Popover
            id={id}
            label={props.source.title}
            anchor={button()}
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
        )}
      </Show>
    </div>
  );
}

export function ChatSourcePreviews(props: SourcePreviewsProps) {
  const [revision, setRevision] = createSignal(0);
  const [failedFavicons, setFailedFavicons] = createSignal<ReadonlySet<string>>(new Set<string>());
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const refreshFavicons = () => {
    if (active) {
      setRevision((value) => value + 1);
    }
  };
  const favicon = (source: ChatSourcePreview) => {
    revision();
    const url = props.fetchFavicon
      ? readLinkFavicon(new URL(source.url).hostname, props.fetchFavicon, refreshFavicons)
      : null;
    return url && !failedFavicons().has(url) ? url : null;
  };
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
              {(source) => (
                <SourceCard
                  source={source()}
                  favicon={favicon(source())}
                  onImageError={(url) => setFailedFavicons((failed) => new Set([...failed, url]))}
                />
              )}
            </For>
          </div>
        </div>
      </openclaw-chat-sources>
    </Show>
  );
}
