import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, getOwner, onCleanup, runWithOwner, Show } from "solid-js";
import type { MarkdownJson } from "../../../components/markdown-json.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedJsonHtml } from "../../../components/markdown.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import {
  type MarkdownDomMedia,
  MarkdownDomReconciler,
} from "../../../lib/markdown-dom-reconciler.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { mountLitContent } from "../../../lit/solid-content.tsx";
import type { MarkdownMedia } from "./chat-message-media-markdown.ts";
import { messageOverflowRef, shouldCollapseUserMessage } from "./chat-message-overflow.ts";
import {
  type DuplicateSuffix,
  type MessageTextOptions,
  prepareMessageMarkdown,
} from "./chat-message-text-preparation.ts";

export type { AssistantMessageDisclosure } from "./chat-message-text-preparation.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

export function renderSolidMessageJson(
  json: MarkdownJson,
  messageKey: string,
  options: MessageTextOptions,
  markdownOptions: MarkdownRenderOptions,
) {
  return (
    <MessageJson
      json={json}
      messageKey={messageKey}
      options={options}
      markdownOptions={markdownOptions}
    />
  );
}

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

export function renderSolidMessageMarkdown(
  markdown: string,
  messageKey: string,
  options: MessageTextOptions,
  markdownOptions: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  media?: MarkdownMedia,
) {
  return (
    <MessageMarkdown
      markdown={markdown}
      messageKey={messageKey}
      options={options}
      markdownOptions={markdownOptions}
      duplicateSuffix={duplicateSuffix}
      media={media}
    />
  );
}

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
  let element!: HTMLDivElement;
  let previous: ((element?: Element) => void) | undefined;
  const dependencies = createMemo(
    () => ({ parts: props.parts, expanded: props.expanded, forwarded: props.forwarded }),
    {
      equals: (before, next) =>
        before.expanded === next.expanded &&
        before.forwarded === next.forwarded &&
        before.parts.length === next.parts.length &&
        before.parts.every((value, index) => value === next.parts[index]),
    },
  );
  createEffect(dependencies, ({ expanded, forwarded }) => {
    previous?.(undefined);
    previous = messageOverflowRef(expanded, forwarded);
    previous(element);
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

export type MarkdownContentValue =
  | string
  | {
      messageKey: string;
      source: string;
      parts: readonly [string, string];
    };

type MarkdownContentProps = {
  content: MarkdownContentValue;
  media?: MarkdownMedia;
  incremental?: boolean;
};

/** Both transcript text and legacy slots share the same incremental DOM owner. */
export function MarkdownContent(props: MarkdownContentProps) {
  const solidOwner = getOwner();
  const fragment = document.createDocumentFragment();
  const owner = new MarkdownDomReconciler(fragment);
  createEffect(
    () => [props.content, props.media, props.incremental] as const,
    ([content, media, incremental]) => {
      const renderer: MarkdownDomMedia | undefined = media && {
        prefix: media.prefix,
        render(index, container) {
          const item = media.items[index];
          if (!item) {
            return undefined;
          }
          return runWithOwner(solidOwner, () =>
            mountLitContent(media.render(item, index), container),
          );
        },
      };
      if (typeof content === "string") {
        owner.updateHtml(content, renderer, incremental);
      } else {
        owner.update(content.messageKey, content.source, content.parts, renderer);
      }
    },
  );
  onCleanup(() => owner.dispose());
  return Array.from(fragment.childNodes);
}

export function MarkdownText(
  props: MarkdownContentProps & { direction?: "ltr" | "rtl" | "auto"; class?: string },
) {
  return (
    <div class={props.class ?? "chat-text"} dir={props.direction}>
      <MarkdownContent
        content={props.content}
        media={props.media}
        incremental={props.incremental}
      />
    </div>
  );
}
