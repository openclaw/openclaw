import type { JSX as SolidJSX } from "@solidjs/web";
import {
  createMemo,
  createSignal,
  Errored,
  isPending,
  latest,
  Loading,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { MarkdownBlocks } from "../../../components/markdown-blocks-owner.ts";
import { createMarkdownRef } from "../../../components/markdown-dom-ref.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/canvas-embed-policy.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { AttachmentPreviewSkeleton } from "./chat-attachment-card-solid.tsx";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import { HtmlPreview } from "./chat-html-preview-view.tsx";
import { isHtmlDocument } from "./chat-html-preview.ts";

registerEnglishCatalog(registerChatComposerEnglish);

registerEnglishCatalog(registerChatMediaEnglish);

registerEnglishCatalog(registerChatSessionOptionalEnglish);

registerEnglishCatalog(registerFilePreviewEnglish);

function MarkdownAttachment(props: { text: string; label: string }) {
  let article!: HTMLElement;
  const markdown = createMarkdownRef(() => ({
    incremental: true,
    content: toSanitizedMarkdownHtml(props.text, {
      mode: "document",
      remoteImages: false,
      codeBlockInteraction: "interactive",
    }),
  }));
  onSettled(() => {
    const blocks = new MarkdownBlocks(article);
    blocks.update(true);
    return () => blocks.dispose();
  });
  return (
    <article
      ref={(element) => {
        article = element;
        markdown(element);
      }}
      class="sidebar-attachment-preview__markdown sidebar-markdown-reader sidebar-markdown"
      dir={detectTextDirection(props.text)}
      aria-label={props.label}
    />
  );
}

type TextAttachmentProps = {
  mobile: boolean;
  plainText: boolean;
  actions: SolidJSX.Element;
  embedSandboxMode: EmbedSandboxMode;
  src: string;
  sourceIdentity: string;
  label: string;
  mimeType: string;
  sizeBytes: number | undefined;
};

type TextRead =
  | { status: "empty" }
  | { status: "ready"; text: string }
  | { status: "failed"; error: unknown };

function TextAttachment(props: TextAttachmentProps, host: SolidBridgeElement<TextAttachmentProps>) {
  host.style.display = "contents";
  // A different attachment starts in preview mode; renewed tickets keep the chosen view.
  const identity = createMemo(() => props.sourceIdentity);
  const [source, setSource] = createSignal(() => {
    identity();
    return false;
  });
  const [retry, setRetry] = createSignal(0);
  const htmlDocument = () => !props.plainText && isHtmlDocument(props.mimeType, props.label);
  const markdown = () => {
    const mimeType = props.mimeType.split(";", 1)[0]?.trim().toLowerCase();
    return (
      !props.plainText &&
      (mimeType === "text/markdown" ||
        mimeType === "text/x-markdown" ||
        /\.(?:md|markdown)$/i.test(props.label))
    );
  };
  // Ticket renewal retains a reader; changed identity or validation retires its observers.
  const readScope = createMemo(
    () => ({
      src: props.src,
      identity: props.sourceIdentity,
      size: props.sizeBytes,
      plain: props.plainText,
      mime: props.mimeType,
      label: props.label,
      retry: retry(),
      html: htmlDocument(),
    }),
    {
      equals: (before, after) =>
        before.identity === after.identity &&
        before.size === after.size &&
        before.plain === after.plain &&
        before.mime === after.mime &&
        before.label === after.label &&
        before.retry === after.retry &&
        (after.identity ? Boolean(before.src) === Boolean(after.src) : before.src === after.src),
    },
  );
  // Keep one pending presentation through metadata resolution and the first body read.
  const skeleton = <AttachmentPreviewSkeleton />;
  const readSource = (scope: ReturnType<typeof readScope>) => {
    const result = createMemo<TextRead>(async (previous) => {
      const current = { ...scope, src: props.src };
      if (!current.src) {
        return { status: "empty" };
      }
      const controller = new AbortController();
      let active = true;
      onCleanup(() => {
        active = false;
        controller.abort();
      });
      const isCurrent = () =>
        active &&
        host.src === current.src &&
        host.sourceIdentity === current.identity &&
        host.sizeBytes === current.size &&
        host.plainText === current.plain &&
        host.mimeType === current.mime &&
        host.label === current.label;
      if (!isCurrent()) {
        return previous ?? { status: "empty" };
      }
      let value: TextRead;
      try {
        const text = await readAttachmentText(
          current.src,
          current.size,
          controller.signal,
          current.html ? "html" : "full",
        );
        value = { status: "ready", text };
      } catch (error) {
        // Commit failure too: a renewed URL must not resurrect previously discarded text.
        value = { status: "failed", error };
      }
      // The bridge prepares content before connection; only adoption requires a connected host.
      return host.isConnected && isCurrent() ? value : (previous ?? { status: "empty" });
    });
    const reader = createMemo(
      () => {
        const value = result();
        return value.status === "ready" ? { text: value.text } : undefined;
      },
      { equals: (before, after) => before?.text === after?.text },
    );
    const pending = () => isPending(result) || result().status === "empty";
    const readFailure = () => {
      const value = result();
      if (value.status === "failed") {
        throw value.error;
      }
      return null;
    };
    return (
      <>
        <div class="sidebar-file-toolbar">
          <span
            ref={createTextOverflow(() => props.mimeType)}
            class="sidebar-file-toolbar__type"
            title={props.mimeType}
          >
            {props.mimeType || props.label.split(".").at(-1)}
          </span>
          {props.sizeBytes !== undefined && <span>{formatBytes(props.sizeBytes)}</span>}
          <span class="sidebar-file-toolbar__actions">
            <Loading>
              <Show when={reader()}>
                {(content) => <CopyButton text={content().text} idleLabel={t("common.copy")} />}
              </Show>
            </Loading>
            <span class="lit-content" style={{ display: "contents" }}>
              {props.actions}
            </span>
            <Loading>
              <Show when={result().status === "failed" && !pending()}>
                <button
                  class="btn btn--sm"
                  type="button"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  {t("common.retry")}
                </button>
              </Show>
              <Show when={(markdown() || htmlDocument()) && reader()}>
                <button
                  class="btn btn--sm"
                  type="button"
                  aria-pressed={source() ? "true" : "false"}
                  onClick={() => setSource((value) => !value)}
                >
                  {source()
                    ? t("chat.workspaceFiles.preview")
                    : htmlDocument()
                      ? t("chat.detailPanel.viewSource")
                      : t("chat.detailPanel.viewRawText")}
                </button>
              </Show>
            </Loading>
            <Show when={!props.mobile}>
              <a
                class="rail-header__action"
                href={props.src || undefined}
                download={props.label}
                target="_blank"
                rel="noreferrer"
                aria-label={t("chat.mediaPlayer.download", { filename: props.label })}
              >
                <Icon name="download" />
              </a>
            </Show>
          </span>
        </div>
        <Loading fallback={skeleton}>
          {/* Errored retains children; retire the reader separately so its observers stop. */}
          <Show when={reader()} keyed>
            {(content) => (
              <>
                <Show when={htmlDocument()}>
                  <div class="chat-html-preview" hidden={source()}>
                    <HtmlPreview
                      content={content.text}
                      sourceIdentity={props.sourceIdentity || props.src}
                      title={props.label}
                      embedSandboxMode={props.embedSandboxMode}
                    />
                  </div>
                </Show>
                {markdown() && !htmlDocument() && !source() ? (
                  <MarkdownAttachment text={content.text} label={props.label} />
                ) : (
                  <pre
                    class="sidebar-attachment-preview__text"
                    tabindex={0}
                    aria-label={props.label}
                    hidden={htmlDocument() && !source()}
                  >
                    {content.text}
                  </pre>
                )}
              </>
            )}
          </Show>
          <Show
            when={!latest(reader) && pending()}
            fallback={
              <Errored
                fallback={() => (
                  <p class="muted" role="status">
                    {t(
                      htmlDocument()
                        ? "chat.attachments.htmlPreviewUnavailable"
                        : "chat.attachments.textPreviewUnavailable",
                    )}
                  </p>
                )}
              >
                {readFailure()}
              </Errored>
            }
          >
            {skeleton}
          </Show>
        </Loading>
      </>
    );
  };
  return (
    <Show when={readScope()} keyed>
      {readSource}
    </Show>
  );
}

export const ChatTextAttachment = defineSolidBridge<TextAttachmentProps>(
  "openclaw-chat-text-attachment",
  TextAttachment,
  {
    properties: {
      mobile: { default: false },
      plainText: { default: false },
      actions: { default: undefined, attribute: false },
      embedSandboxMode: { default: "scripts" },
      src: { default: "" },
      sourceIdentity: { default: "" },
      label: { default: "" },
      mimeType: { default: "" },
      sizeBytes: { default: undefined, type: Number },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-text-attachment": SolidBridgeElement<TextAttachmentProps>;
  }
}
