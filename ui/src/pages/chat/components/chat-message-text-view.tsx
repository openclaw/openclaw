import { dynamic, insert, type JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  Show,
  useContext,
} from "solid-js";
import {
  createMarkdownRef,
  type MarkdownContentValue,
} from "../../../components/markdown-dom-ref.ts";
import type { MarkdownJson } from "../../../components/markdown-json.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedJsonHtml } from "../../../components/markdown.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { MarkdownDomMedia, MarkdownMediaRoot } from "../../../lib/markdown-dom-reconciler.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import type { MarkdownMedia } from "./chat-message-media-markdown.ts";
import { messageOverflowRef, shouldCollapseUserMessage } from "./chat-message-overflow.ts";
import {
  type DuplicateSuffix,
  type MessageTextOptions,
  prepareMessageMarkdown,
} from "./chat-message-text-preparation.ts";

export type { AssistantMessageDisclosure } from "./chat-message-text-preparation.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

export function MessageJson(props: {
  json: MarkdownJson;
  messageKey: string;
  options: MessageTextOptions;
  markdownOptions: MarkdownRenderOptions;
}) {
  const content = createMemo(() => toSanitizedJsonHtml(props.json, props.markdownOptions));
  return (
    <TextDisclosure
      source={props.json.text}
      messageKey={props.messageKey}
      options={props.options}
      parts={[content()]}
    >
      <MarkdownText content={content()} />
    </TextDisclosure>
  );
}

export type MessageMarkdownProps = {
  markdown: string;
  messageKey: string;
  options: MessageTextOptions;
  markdownOptions: MarkdownRenderOptions;
  duplicateSuffix?: DuplicateSuffix;
  media?: MarkdownMedia;
};

export function MessageMarkdown(props: MessageMarkdownProps) {
  const presentation = createMemo(() =>
    prepareMessageMarkdown(
      props.markdown,
      props.messageKey,
      props.options,
      props.markdownOptions,
      props.duplicateSuffix,
    ),
  );
  return (
    <>
      <TextDisclosure
        source={props.markdown}
        messageKey={props.messageKey}
        options={props.options}
        parts={presentation().parts}
      >
        <MarkdownText
          content={presentation()}
          media={props.media}
          direction={detectTextDirection(props.media?.text ?? presentation().source)}
        />
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
  parts: readonly string[];
  children: JSX.Element;
}) {
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
    <Show when={collapsed()} fallback={props.children}>
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
        >
          {props.children}
        </DisclosureContent>
        <button
          class="chat-message-disclosure__toggle"
          type="button"
          aria-expanded={expanded() ? "true" : "false"}
          onClick={() => props.options.onToggleUserMessageExpanded?.(disclosureId())}
        >
          {t(expanded() ? "chat.messages.showLess" : "chat.messages.showMore")}
          <Icon name={expanded() ? "chevronUp" : "chevronDown"} />
        </button>
      </div>
    </Show>
  );
}

function DisclosureContent(props: {
  parts: readonly string[];
  expanded: boolean;
  forwarded: boolean;
  children: JSX.Element;
}) {
  const presented = useContext(ContentPresentation);
  let element!: HTMLDivElement;
  let previous: ((element?: Element) => void) | undefined;
  const dependencies = createMemo(
    () => ({
      parts: props.parts,
      expanded: props.expanded,
      forwarded: props.forwarded,
      connected: presented(),
    }),
    {
      equals: (before, next) =>
        before.expanded === next.expanded &&
        before.forwarded === next.forwarded &&
        before.connected === next.connected &&
        before.parts.length === next.parts.length &&
        before.parts.every((value, index) => value === next.parts[index]),
    },
  );
  createEffect(dependencies, ({ expanded, forwarded, connected }) => {
    previous?.(undefined);
    previous = connected ? messageOverflowRef(expanded, forwarded) : undefined;
    previous?.(element);
  });
  onCleanup(() => previous?.(undefined));
  return (
    <div
      class="chat-message-disclosure__content"
      ref={(node) => {
        element = node;
      }}
    >
      {props.children}
    </div>
  );
}

type MarkdownContentProps = {
  content: MarkdownContentValue;
  media?: MarkdownMedia;
  incremental?: boolean;
};

/** Transcript text and inline media share the same incremental DOM owner. */
export function MarkdownContent(props: MarkdownContentProps) {
  const solidOwner = getOwner();
  const presented = useContext(ContentPresentation);
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
    return { content: props.content, media: renderer, incremental: props.incremental, connected };
  });
  markdown(fragment);
  return Array.from(fragment.childNodes);
}

export function MarkdownText(
  props: MarkdownContentProps & { direction?: "ltr" | "rtl" | "auto"; class?: string },
) {
  return (
    <div class={props.class ?? "chat-text"} dir={props.direction}>
      <MarkdownContent {...props} />
    </div>
  );
}
