import { dynamic, insert, type JSX } from "@solidjs/web";
import {
  children,
  createMemo,
  createSignal,
  createUniqueId,
  createRoot,
  getOwner,
  latest,
  runWithOwner,
  Show,
  useContext,
} from "solid-js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import {
  createMarkdownRef,
  type MarkdownContentValue,
} from "../../../components/markdown-dom-ref.ts";
import type { MarkdownJson } from "../../../components/markdown-json.ts";
import { loadStreamingMarkdown } from "../../../components/markdown-live-loader.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { partitionMarkdownHtml, toSanitizedJsonHtml } from "../../../components/markdown.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import {
  markdownContentHtml,
  type MarkdownContent as PreparedMarkdownContent,
} from "../../../lib/markdown-content.ts";
import type { MarkdownDomMedia, MarkdownMediaRoot } from "../../../lib/markdown-dom-reconciler.ts";
import { elementRef as registerElementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import { hydrateLinkFavicons, releaseLinkFavicons } from "../link-favicon-loader.ts";
import { openInlineChatImage } from "./chat-image-lightbox.ts";
import type { MarkdownMedia } from "./chat-message-media-markdown.ts";
import { messageOverflowRef, shouldCollapseUserMessage } from "./chat-message-overflow.ts";
import {
  type MessageTextOptions,
  prepareMessageMarkdown,
} from "./chat-message-text-preparation.ts";
import { ChatRowDisplayContext } from "./chat-row-display-context.ts";
import { registerChatSearchTextBlock } from "./chat-search-highlight.ts";

export type { AssistantMessageDisclosure } from "./chat-message-text-preparation.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

export function MessageJson(props: {
  json: MarkdownJson;
  messageKey: string;
  options: MessageTextOptions;
  markdownOptions: MarkdownRenderOptions;
}) {
  const content = createMemo(() => ({
    messageKey: props.messageKey,
    source: props.json.text,
    parts: partitionMarkdownHtml(toSanitizedJsonHtml(props.json, props.markdownOptions)),
  }));
  return (
    <TextDisclosure
      source={props.json.text}
      messageKey={props.messageKey}
      options={props.options}
      parts={content().parts}
    >
      {(elementRef) => (
        <MarkdownText
          content={content()}
          elementRef={elementRef}
          fetchLinkFavicon={props.options.fetchLinkFavicon}
        />
      )}
    </TextDisclosure>
  );
}

export type MessageMarkdownProps = {
  markdown: string;
  messageKey: string;
  options: MessageTextOptions;
  markdownOptions: MarkdownRenderOptions;
  media?: MarkdownMedia;
  onOpenImage?: (item: ImageLightboxItem, index: number) => void;
};

export function MessageMarkdown(props: MessageMarkdownProps) {
  const streaming = createMemo(
    () =>
      props.options.isStreaming
        ? (loadStreamingMarkdown.peek() ?? loadStreamingMarkdown())
        : loadStreamingMarkdown.peek(),
    { loadingValue: undefined },
  );
  const presentation = createMemo(() =>
    prepareMessageMarkdown(
      props.markdown,
      props.messageKey,
      props.options,
      props.markdownOptions,
      latest(streaming)?.toStreamingMarkdownDomParts,
      props.options.isStreaming && !latest(streaming),
    ),
  );
  return (
    <>
      <TextDisclosure
        source={props.markdown}
        messageKey={props.messageKey}
        options={props.options}
        parts={presentation().parts()}
      >
        {(elementRef) => (
          <MarkdownText
            content={presentation()}
            media={props.media}
            onOpenImage={props.onOpenImage}
            direction={detectTextDirection(props.media?.text ?? presentation().source)}
            elementRef={elementRef}
            fetchLinkFavicon={props.options.fetchLinkFavicon}
          />
        )}
      </TextDisclosure>
      <Show
        when={
          presentation().recoverFullMessage &&
          props.options.assistantMessageDisclosure?.onRetryFullMessage
        }
      >
        <div class="chat-message-load-error">
          {t("chat.messages.fullContentLoadExhausted")}
          <button
            type="button"
            class="chat-message-load-error__retry"
            onClick={() => props.options.assistantMessageDisclosure?.onRetryFullMessage?.()}
          >
            {t("common.retry")}
          </button>
        </div>
      </Show>
    </>
  );
}

function TextDisclosure(props: {
  source: string;
  messageKey: string;
  options: MessageTextOptions;
  parts: readonly [PreparedMarkdownContent, PreparedMarkdownContent];
  children: (elementRef: (element: HTMLDivElement) => void) => JSX.Element;
}) {
  let text: HTMLDivElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  const content = children(() =>
    props.children((element) => {
      text = element;
    }),
  );
  const getNodes = () => ({ text, toggle });
  const collapsed = () =>
    Boolean(
      props.options.onToggleUserMessageExpanded &&
      (props.options.isForwarded
        ? !props.options.isStreaming
        : props.options.role === "user" && shouldCollapseUserMessage(props.source)),
    );
  const disclosureId = () =>
    `${props.options.isForwarded ? "forwarded" : "user"}-message:${props.messageKey}`;
  const expanded = () => props.options.isUserMessageExpanded?.(disclosureId()) ?? false;
  return (
    <Show when={collapsed()} fallback={content()}>
      <div
        class={[
          "chat-message-disclosure",
          {
            "chat-message-disclosure--forwarded": props.options.isForwarded,
            "is-expanded": expanded(),
          },
        ]}
      >
        <DisclosureContent
          parts={props.parts}
          expanded={expanded()}
          forwarded={Boolean(props.options.isForwarded)}
          getNodes={getNodes}
        >
          {content()}
        </DisclosureContent>
        <DisclosureToggle
          expanded={expanded()}
          buttonRef={(element) => {
            toggle = element;
          }}
          onToggle={() => props.options.onToggleUserMessageExpanded?.(disclosureId())}
        />
      </div>
    </Show>
  );
}

function DisclosureToggle(props: {
  expanded: boolean;
  controls?: string;
  buttonRef: (element: HTMLButtonElement) => void;
  onToggle: () => void;
}) {
  return (
    <button
      class="chat-message-disclosure__toggle"
      ref={(element) => props.buttonRef(element)}
      type="button"
      aria-expanded={props.expanded ? "true" : "false"}
      aria-controls={props.controls}
      onClick={() => props.onToggle()}
    >
      {t(props.expanded ? "chat.messages.showLess" : "chat.messages.showMore")}
      <Icon name={props.expanded ? "chevronUp" : "chevronDown"} aria-hidden="true" />
    </button>
  );
}

/** A sender description previews a separate message, even when the preview fits. */
export function ForwardedDescriptionDisclosure(props: {
  description: string;
  expanded?: boolean;
  searchResult?: boolean;
  onToggle?: (wasExpanded: boolean) => void;
  children: JSX.Element;
}) {
  const [localExpanded, setLocalExpanded] = createSignal(false);
  const expanded = () =>
    props.searchResult ||
    (props.onToggle ? props.expanded : (props.expanded ?? localExpanded())) ||
    false;
  const originalId = createUniqueId();
  let original: HTMLDivElement | undefined;
  const presented = useContext(ContentPresentation);
  let text: HTMLDivElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  return (
    <div
      class={[
        "chat-message-disclosure chat-message-disclosure--description",
        { "is-expanded": expanded() },
      ]}
    >
      <div
        class="chat-message-disclosure__content"
        ref={messageOverflowRef(
          () => ({
            expanded: expanded(),
            forwarded: false,
            connected: presented(),
            plainTextPreview: true,
          }),
          () => ({ text, toggle }),
        )}
      >
        <div
          class="chat-text chat-message-disclosure__description"
          dir="auto"
          ref={(element) => {
            text = element;
          }}
        >
          {props.description.replace(/[\u2028\u2029]/gu, " ")}
        </div>
      </div>
      <div
        id={originalId}
        hidden={!expanded()}
        tabindex={-1}
        ref={(element) => {
          original = element;
        }}
      >
        <Show when={expanded()}>
          <div class="chat-message-disclosure__original">{props.children}</div>
        </Show>
      </div>
      <Show when={!props.searchResult}>
        <DisclosureToggle
          expanded={expanded()}
          controls={originalId}
          buttonRef={(element) => {
            toggle = element;
          }}
          onToggle={() => {
            const wasExpanded = expanded();
            if (props.onToggle) {
              props.onToggle(wasExpanded);
            } else {
              setLocalExpanded((open) => !open);
            }
            if (wasExpanded || document.activeElement === toggle) {
              requestAnimationFrame(() => {
                if (wasExpanded && !expanded()) {
                  // The row anchor is above the viewport when a long body shrinks.
                  toggle?.scrollIntoView({ block: "nearest" });
                } else if (!wasExpanded && document.activeElement === toggle) {
                  // The revealed content precedes the toggle. Begin Tab order there.
                  original?.focus({ preventScroll: true });
                }
              });
            }
          }}
        />
      </Show>
    </div>
  );
}

function DisclosureContent(props: {
  parts: readonly [PreparedMarkdownContent, PreparedMarkdownContent];
  expanded: boolean;
  forwarded: boolean;
  getNodes: () => { text?: HTMLElement; toggle?: HTMLButtonElement };
  children: JSX.Element;
}) {
  const presented = useContext(ContentPresentation);
  const measurementOptions = createMemo(
    () => ({
      parts: props.parts,
      expanded: props.expanded,
      forwarded: props.forwarded,
      connected: presented(),
    }),
    {
      equals: (before, next) =>
        markdownContentHtml(before.parts[0]) === markdownContentHtml(next.parts[0]) &&
        markdownContentHtml(before.parts[1]) === markdownContentHtml(next.parts[1]) &&
        before.expanded === next.expanded &&
        before.forwarded === next.forwarded &&
        before.connected === next.connected,
    },
  );
  const overflow = messageOverflowRef(measurementOptions, () => props.getNodes());
  return (
    <div class="chat-message-disclosure__content" ref={overflow}>
      {props.children}
    </div>
  );
}

type MarkdownContentProps = {
  content: MarkdownContentValue;
  media?: MarkdownMedia;
  incremental?: boolean;
  onUpdate?: () => void;
};

/** Transcript text and inline media share the same incremental DOM owner. */
export function MarkdownContent(props: MarkdownContentProps) {
  // The markdown reconciler owns media containers outside Solid's DOM tree.
  // Its callbacks mount media with this context; the reconciler retires each root.
  const solidOwner = getOwner();
  const presented = useContext(ContentPresentation);
  const display = useContext(ChatRowDisplayContext);
  const fragment = document.createDocumentFragment();
  const roots = new Map<
    HTMLElement,
    MarkdownMediaRoot & { update: (media: MarkdownMedia) => void }
  >();
  const markdown = createMarkdownRef(() => {
    const connected = presented();
    const media = props.media;
    const renderer: MarkdownDomMedia | undefined = media && {
      prefix: media.prefix,
      render(index, container) {
        const item = media.items[index];
        if (!item) {
          return undefined;
        }
        const existing = roots.get(container);
        if (existing) {
          existing.update(media);
          return existing;
        }
        const root = runWithOwner(solidOwner, () =>
          createRoot((dispose) => {
            const [current, update] = createSignal(media, { equals: false, ownedWrite: true });
            const [active, setConnected] = createSignal(connected, { ownedWrite: true });
            const Content = dynamic(() => current().render);
            insert(
              container,
              <ContentPresentation value={active}>
                <Content item={current().items[index]!} index={index} />
              </ContentPresentation>,
            );
            return {
              update,
              setConnected,
              dispose() {
                roots.delete(container);
                dispose();
                container.replaceChildren();
              },
            };
          }),
        );
        roots.set(container, root);
        return root;
      },
    };
    return {
      content: props.content,
      media: renderer,
      incremental: props.incremental,
      connected,
      onUpdate: props.onUpdate,
    };
  }, display);
  markdown(fragment);
  return Array.from(fragment.childNodes);
}

export function MarkdownText(
  props: MarkdownContentProps & {
    direction?: "ltr" | "rtl" | "auto";
    class?: string;
    /** Keeps a collapsed preview out of focus, selection and the accessibility tree. */
    inert?: boolean;
    elementRef?: (element: HTMLDivElement) => void;
    fetchLinkFavicon?: LinkFaviconFetcher;
    onOpenImage?: (item: ImageLightboxItem, index: number) => void;
  },
) {
  const openImage = (event: Event) => {
    const onOpenImage = props.onOpenImage;
    if (onOpenImage && event.currentTarget instanceof HTMLElement) {
      openInlineChatImage(
        event,
        (item, index) => {
          if (index !== undefined) {
            onOpenImage(item, index);
          }
        },
        event.currentTarget,
      );
    }
  };
  let element!: HTMLDivElement;
  const hydrate = createMemo(() => {
    const fetcher = props.fetchLinkFavicon;
    return () => hydrateLinkFavicons(element, fetcher);
  });
  return (
    <div
      class={props.class ?? "chat-text"}
      inert={props.inert}
      dir={props.direction}
      onClick={openImage}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          openImage(event);
        }
      }}
      ref={[
        registerElementRef((node: HTMLDivElement) => {
          element = node;
          props.elementRef?.(node);
          return () => releaseLinkFavicons(node);
        }),
        registerElementRef(registerChatSearchTextBlock),
      ]}
    >
      <MarkdownContent {...props} onUpdate={hydrate()} />
    </div>
  );
}
