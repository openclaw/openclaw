import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { LazyCustomElementRequestController } from "../../../app/lazy-custom-element.ts";
import { MarkdownBlocks } from "../../../components/markdown-blocks-owner.ts";
import { createMarkdownRef } from "../../../components/markdown-dom-ref.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import {
  defineSolidBridge,
  LitContent,
  type SolidBridgeElement,
} from "../../../lit/solid-bridge.ts";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import { htmlPreviewElement, isHtmlDocument } from "./chat-html-preview.ts";

registerEnglishCatalog(registerFilePreviewEnglish);

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-html-preview": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-html-preview"]
      > &
        Properties<HTMLElementTagNameMap["openclaw-chat-html-preview"]>;
    }
  }
}

function MarkdownAttachment(props: { text: string; label: string }) {
  let article!: HTMLElement;
  const markdown = createMarkdownRef(() => ({
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
  plainText: boolean;
  actions: unknown;
  embedSandboxMode: EmbedSandboxMode;
  src: string;
  sourceIdentity: string;
  label: string;
  mimeType: string;
  sizeBytes: number | undefined;
};
export function isTextAttachment(rawMimeType: string, filename: string): boolean {
  const mimeType = rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("text/")) {
    return true;
  }
  if (
    /^application\/(?:(?:[\w.-]+\+)?(?:json|xml)|javascript|x-javascript|yaml|x-yaml)$/.test(
      mimeType,
    )
  ) {
    return true;
  }
  return (
    (!mimeType || mimeType === "application/octet-stream") &&
    /\.(?:txt|md|markdown|html?|log|csv|tsv|json|jsonl|xml|yaml|yml)$/i.test(filename)
  );
}

function TextAttachment(props: TextAttachmentProps, host: SolidBridgeElement<TextAttachmentProps>) {
  host.style.display = "contents";
  const [text, setText] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [source, setSource] = createSignal(false);
  const [version, setVersion] = createSignal(0);
  const [retry, setRetry] = createSignal(0);
  const [loaderRevision, setLoaderRevision] = createSignal(0);
  let disposed = false;
  const htmlPreviewLoader = new LazyCustomElementRequestController({
    requestUpdate: () => {
      if (!disposed) {
        setLoaderRevision((value) => value + 1);
      }
    },
    get updateComplete() {
      return host.updateComplete;
    },
  });
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
  const sourceInput = createMemo(
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
        before.src === after.src &&
        before.identity === after.identity &&
        before.size === after.size &&
        before.plain === after.plain &&
        before.mime === after.mime &&
        before.label === after.label &&
        before.retry === after.retry,
    },
  );
  createEffect(sourceInput, (current, previous) => {
    const policyChanged =
      !previous ||
      previous.plain !== current.plain ||
      previous.mime !== current.mime ||
      previous.label !== current.label;
    const identityChanged = !previous || previous.identity !== current.identity;
    const clear =
      policyChanged ||
      identityChanged ||
      previous?.size !== current.size ||
      previous?.retry !== current.retry ||
      !current.src ||
      !current.identity;
    if (identityChanged) {
      setSource(false);
    }
    if (clear) {
      setText(null);
    }
    setFailed(false);
    setVersion((value) => value + 1);
    if (!current.src) {
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    const isCurrent = () =>
      active &&
      host.isConnected &&
      host.src === current.src &&
      host.sourceIdentity === current.identity &&
      host.sizeBytes === current.size &&
      host.plainText === current.plain &&
      host.mimeType === current.mime &&
      host.label === current.label;
    void readAttachmentText(
      current.src,
      current.size,
      controller.signal,
      current.html ? "html" : "full",
    ).then(
      (value) => {
        if (isCurrent()) {
          setText(value);
        }
      },
      () => {
        if (isCurrent()) {
          setText(null);
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  });
  createEffect(
    () => htmlDocument() && text() !== null && !failed(),
    (active) => htmlPreviewLoader.requestWhileActive(htmlPreviewElement, active),
  );
  onCleanup(() => {
    disposed = true;
    htmlPreviewLoader.requestWhileActive(htmlPreviewElement, false);
  });
  const htmlLoadState = () => {
    loaderRevision();
    const state = htmlPreviewLoader.visibleState;
    return state?.status === "error" ? (
      <LazyViewError
        error={state.error}
        stale={state.stale}
        onRetry={() => htmlPreviewLoader.retry()}
      />
    ) : state ? (
      <div role="status">{t("common.loading")}</div>
    ) : null;
  };
  const reader = createMemo(
    () => {
      const value = text();
      return value === null ? undefined : { text: value, key: props.sourceIdentity || version() };
    },
    { equals: (before, after) => before?.text === after?.text && before?.key === after?.key },
  );
  return (
    <>
      <div class="sidebar-file-toolbar">
        <span class="sidebar-file-toolbar__type" title={props.mimeType}>
          {props.mimeType || props.label.split(".").at(-1)}
        </span>
        {props.sizeBytes !== undefined && <span>{formatBytes(props.sizeBytes)}</span>}
        <span class="sidebar-file-toolbar__actions">
          {text() !== null && !failed() && (
            <CopyButton text={text()!} idleLabel={t("common.copy")} />
          )}
          <LitContent render={() => props.actions} />
          {failed() && (
            <button
              class="btn btn--sm"
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t("common.retry")}
            </button>
          )}
          {(markdown() || htmlDocument()) && text() !== null && (
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
          )}
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
        </span>
      </div>
      {failed() ? (
        <p class="muted" role="status">
          {t(
            htmlDocument()
              ? "chat.attachments.htmlPreviewUnavailable"
              : "chat.attachments.textPreviewUnavailable",
          )}
        </p>
      ) : (
        <Show
          when={reader()}
          keyed
          fallback={
            <div
              class="sidebar-attachment-preview__loading"
              role="status"
              aria-label={t("common.loading")}
            >
              <div class="skeleton skeleton-line" aria-hidden="true" />
              <div class="skeleton skeleton-line skeleton-line--long" aria-hidden="true" />
              <div class="skeleton skeleton-line skeleton-line--medium" aria-hidden="true" />
            </div>
          }
        >
          {(content) => (
            <>
              {htmlDocument() ? (
                <>
                  <div class="chat-html-preview" hidden={source()}>
                    {htmlLoadState()}
                    <openclaw-chat-html-preview
                      prop:html={content.text}
                      prop:sourceIdentity={props.sourceIdentity || props.src}
                      title={props.label}
                      prop:embedSandboxMode={props.embedSandboxMode}
                    />
                  </div>
                  <pre
                    class="sidebar-attachment-preview__text"
                    tabindex={0}
                    aria-label={props.label}
                    hidden={!source()}
                  >
                    {content.text}
                  </pre>
                </>
              ) : markdown() && !source() ? (
                <MarkdownAttachment text={content.text} label={props.label} />
              ) : (
                <pre class="sidebar-attachment-preview__text" tabindex={0} aria-label={props.label}>
                  {content.text}
                </pre>
              )}
            </>
          )}
        </Show>
      )}
    </>
  );
}

export const ChatTextAttachment = defineSolidBridge<TextAttachmentProps>(
  "openclaw-chat-text-attachment",
  TextAttachment,
  {
    properties: {
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
