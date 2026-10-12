import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, Match, Show, Switch } from "solid-js";
import { formatFencedCodeBlock } from "../../../../../src/shared/markdown-code.js";
import { isStaleChunkImportError } from "../../../app/stale-chunk-reload.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import { markdownBlocksRef } from "../../../components/markdown-element-refs-solid.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
  type MarkdownFileLinkTarget,
} from "../../../components/markdown-file-links.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
  type SessionLinkTarget,
} from "../../../components/markdown-session-links.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import "../../../components/tooltip.ts";
import { McpAppPanel } from "../../../components/solid/mcp-app-panel.tsx";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import {
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { isSvgImageMediaPath } from "../../../lib/media-file-extension.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { emptyLegacyContent } from "../../../lit/solid-content.tsx";
import { AttachmentCardHeader, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import {
  isCrossOriginHttpSource,
  safeAttachmentHref,
  safePlainTextAttachmentHref,
  safeMediaAttachmentHref,
} from "./chat-attachment-href.ts";
import "./chat-audio-player.tsx";
import { openInlineChatImage } from "./chat-image-lightbox.ts";
import "./chat-video-player.tsx";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { isPdfAttachment } from "./chat-pdf-preview.ts";
import type {
  AttachmentSidebarRuntime,
  SidebarContent,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";
import { SidebarFile, type FileViewControls } from "./chat-sidebar-file-view.tsx";
import { ChatTextAttachment, isTextAttachment } from "./chat-text-attachment.tsx";
import { SessionDiffPanel } from "./session-diff-panel.tsx";

registerEnglishCatalog(registerFilePreviewEnglish);

type SidebarAttachmentProps = {
  content: Extract<SidebarContent, { kind: "attachment" }>;
  onRequestUpdate: () => void;
  runtime: AttachmentSidebarRuntime;
  embedSandboxMode: EmbedSandboxMode;
  download?: { pending: boolean; error: string | null; onDownload: () => void };
};

function prepareAttachment(input: SidebarAttachmentProps) {
  const content = input.content;
  const resolution = content.resolveSource?.(input.onRequestUpdate, input.runtime);
  const source = resolution ? (resolution.status === "ready" ? resolution : null) : content;
  const mimeType = content.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const kind: NonNullable<SidebarAttachmentProps["content"]["attachmentKind"]> =
    content.attachmentKind === "video" || mimeType.startsWith("video/")
      ? "video"
      : content.attachmentKind === "audio" || mimeType.startsWith("audio/")
        ? "audio"
        : content.attachmentKind === "image" || mimeType.startsWith("image/")
          ? "image"
          : "document";
  const src = (
    content.plainText
      ? safePlainTextAttachmentHref
      : kind === "audio" || kind === "video"
        ? safeMediaAttachmentHref
        : safeAttachmentHref
  )(source?.src ?? "");
  const pending = resolution?.status === "pending";
  const inferTypeFromExtension = !mimeType || mimeType === "application/octet-stream";
  const blockedExternalSvg =
    (mimeType === "image/svg+xml" ||
      (inferTypeFromExtension &&
        (isSvgImageMediaPath(content.sourceIdentity ?? "", undefined) ||
          isSvgImageMediaPath(src ?? "", undefined) ||
          isSvgImageMediaPath(content.title, undefined)))) &&
    isCrossOriginHttpSource(src ?? "");
  const imagePreview = (src || pending) && !blockedExternalSvg && kind === "image";
  const width = source?.width ?? content.width;
  const height = source?.height ?? content.height;
  return {
    resolution,
    source,
    mimeType,
    kind,
    src,
    pending,
    imagePreview,
    ratio: width && height ? `${width} / ${height}` : undefined,
    sourceIdentity: [
      input.runtime.connectionEpoch ?? "",
      input.runtime.agentId ?? "",
      input.runtime.sessionKey ?? "",
      content.sourceIdentity ?? src ?? "",
    ].join("\u0000"),
    error: resolution?.status === "error" ? resolution.reason : undefined,
    retry:
      resolution?.status === "error" || resolution?.status === "unavailable"
        ? resolution.onRetry
        : undefined,
  };
}

function SidebarAttachment(props: SidebarAttachmentProps) {
  // Download-only attachments never resolve preview sources.
  return (
    <Show
      when={props.content.download && props.download}
      fallback={<AttachmentPreview {...props} />}
    >
      {(download) => (
        <>
          <CompactAttachmentCard
            kind="document"
            label={props.content.title}
            mimeType={props.content.mimeType ?? undefined}
            sizeBytes={props.content.sizeBytes}
            onDownload={download().onDownload}
            downloadPending={download().pending}
          />
          <Show when={download().error}>{(error) => <div role="alert">{error()}</div>}</Show>
        </>
      )}
    </Show>
  );
}

function AttachmentPreview(props: SidebarAttachmentProps) {
  const model = createMemo(() => prepareAttachment(props));
  return (
    <Switch
      fallback={
        <CompactAttachmentCard
          kind={props.content.attachmentKind ?? "document"}
          label={props.content.title}
          mimeType={props.content.mimeType ?? undefined}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
          downloadHref={model().src ?? undefined}
        />
      }
    >
      <Match
        when={
          (model().src || model().pending) &&
          model().kind === "document" &&
          isPdfAttachment(model().mimeType, props.content.title) &&
          !isCrossOriginHttpSource(model().src ?? "")
        }
      >
        <openclaw-chat-pdf-preview
          prop:src={model().src ?? ""}
          prop:sourceIdentity={model().sourceIdentity}
          prop:label={props.content.title}
          prop:mimeType={props.content.mimeType ?? ""}
          prop:sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
        />
      </Match>
      <Match
        when={
          (model().src || model().pending) &&
          isTextAttachment(model().mimeType, props.content.title) &&
          !isCrossOriginHttpSource(model().src ?? "")
        }
      >
        <ChatTextAttachment
          plainText={props.content.plainText ?? false}
          actions={props.content.renderActions?.() ?? emptyLegacyContent}
          embedSandboxMode={props.embedSandboxMode}
          src={model().src ?? ""}
          sourceIdentity={model().sourceIdentity}
          label={props.content.title}
          mimeType={props.content.mimeType ?? ""}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
        />
      </Match>
      <Match when={model().kind === "video" && (model().src || model().pending)}>
        <openclaw-chat-video-player
          prop:src={model().src ?? ""}
          prop:preview={true}
          prop:sourceIdentity={
            props.content.sourceIdentity ?? props.content.src ?? model().src ?? ""
          }
          prop:label={props.content.title}
          prop:mimeType={props.content.mimeType ?? ""}
          prop:playback={model().source?.playback ?? props.content.playback ?? "native"}
          prop:authToken={model().source?.authToken ?? null}
          prop:sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
          prop:mediaWidth={model().source?.width ?? props.content.width}
          prop:mediaHeight={model().source?.height ?? props.content.height}
        />
      </Match>
      <Match when={!model().src || model().imagePreview}>
        <div
          class={`chat-assistant-attachment-card chat-assistant-attachment-card--${model().kind} sidebar-attachment-preview__state-card`}
          aria-busy={model().pending ? "true" : undefined}
        >
          <AttachmentCardHeader
            kind={model().kind}
            label={props.content.title}
            mimeType={props.content.mimeType ?? undefined}
            sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
            downloadHref={model().src ?? undefined}
            downloadPending={model().pending}
            visualMode="preview-with-favicon"
          />
          <div
            class="sidebar-attachment-preview__state"
            style={{ "--preview-ratio": model().ratio }}
          >
            <Show when={model().pending || model().imagePreview}>
              <div
                class="sidebar-attachment-preview__loading"
                role="status"
                aria-label={t("common.loading")}
              >
                <div class="skeleton skeleton-line" aria-hidden="true" />
                <div class="skeleton skeleton-line skeleton-line--long" aria-hidden="true" />
                <div class="skeleton skeleton-line skeleton-line--medium" aria-hidden="true" />
              </div>
            </Show>
            <Show when={model().imagePreview && model().src} keyed>
              {(src) => (
                <img
                  class="sidebar-attachment-preview__image"
                  src={src}
                  alt={props.content.title}
                  onLoad={(event) => {
                    event.currentTarget.dataset.preview = "ready";
                  }}
                  onError={(event) => {
                    event.currentTarget.dataset.preview = "error";
                  }}
                />
              )}
            </Show>
            <Show when={!model().pending}>
              <div class="sidebar-attachment-preview__unavailable">
                {t("chat.attachments.previewUnavailable")}
                <Show when={model().error}>{(error) => <span>{error()}</span>}</Show>
                <Show when={model().retry}>
                  {(retry) => (
                    <button class="btn btn--sm" type="button" onClick={() => retry()()}>
                      {t("common.retry")}
                    </button>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Match>
      <Match when={model().kind === "audio"}>
        <openclaw-chat-audio-player
          prop:src={model().src ?? ""}
          prop:sourceIdentity={
            props.content.sourceIdentity ?? props.content.src ?? model().src ?? ""
          }
          prop:label={props.content.title}
          prop:mimeType={props.content.mimeType ?? ""}
          prop:playback={model().source?.playback ?? props.content.playback ?? "native"}
          prop:authToken={model().source?.authToken ?? null}
          prop:sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
          prop:serverDurationMs={model().source?.durationMs ?? props.content.durationMs}
          prop:voiceNote={props.content.voiceNote === true}
        />
      </Match>
    </Switch>
  );
}
export function buildRawContent(
  content: ChatDetailPanelContent | null | undefined,
): ChatDetailPanelContent | null {
  if (!content) {
    return null;
  }
  const textDocument = content.kind === "markdown" || content.kind === "file";
  const rawText = content.rawText ?? (textDocument ? content.content : "");
  if (!textDocument && !rawText.trim()) {
    return null;
  }
  return {
    kind: "markdown",
    content: formatFencedCodeBlock(
      rawText,
      content.kind === "file" ? content.language : textDocument ? undefined : "json",
    ),
    rawText,
    ...(textDocument
      ? {
          fileLinkSessionKey:
            content.kind === "file"
              ? content.sessionFileSource?.sessionKey
              : content.fileLinkSessionKey,
        }
      : {}),
  };
}

export type SidebarPanelProps = {
  content: ChatDetailPanelContent | null;
  showingRawText: boolean;
  error: Error | null;
  onRetry: () => void;
  fileView?: FileViewControls;
  onClose: () => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onViewRawText: () => void;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  githubRepo?: MarkdownRenderOptions["githubRepo"];
  githubRepositories?: MarkdownRenderOptions["githubRepositories"];
  embedded?: boolean;
  onAttachmentUpdate: () => void;
  attachmentRuntime: AttachmentSidebarRuntime;
  attachmentDownload?: { pending: boolean; error: string | null; onDownload: () => void };
  onClick: (event: MouseEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
};

function sidebarTitle(content: ChatDetailPanelContent | null, showingRawText: boolean) {
  switch (content?.kind) {
    case "mcp-app":
      return content.title;
    case "canvas":
      return content.title?.trim() || t("chat.detailPanel.renderPreview");
    case "image":
      return content.title.trim() || t("chat.detailPanel.imagePreview");
    case "attachment":
      return content.title.trim() || t("chat.detailPanel.file");
    case "file":
      return content.name.trim() || t("chat.detailPanel.file");
    case "session-diff":
      return t("chat.sessionDiff.title");
    case "markdown":
      return t(showingRawText ? "chat.detailPanel.viewSource" : "chat.detailPanel.markdownPreview");
    default:
      return t("chat.detailPanel.toolDetails");
  }
}

function RawButton(props: { onClick: () => void; class?: string; style?: SolidJSX.CSSProperties }) {
  return (
    <button
      onClick={() => props.onClick()}
      class={props.class ?? "btn"}
      type="button"
      style={props.style}
    >
      {t("chat.detailPanel.viewRawText")}
    </button>
  );
}

function CanvasPreview(props: {
  content: Extract<ChatDetailPanelContent, { kind: "canvas" }>;
  title: string;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
}) {
  const sandbox = () =>
    resolveEmbedSandbox(props.embedSandboxMode ?? "scripts", props.content.sandbox);
  const src = () =>
    resolveCanvasIframeUrl(
      props.content.entryUrl,
      props.canvasPluginSurfaceUrl,
      props.allowExternalEmbedUrls ?? false,
    );
  // A changed sandbox, URL, or height restarts the iframe, matching the original keyed preview.
  return (
    <Show
      when={`${sandbox()}\u0000${src() ?? ""}\u0000${props.content.preferredHeight ?? ""}`}
      keyed
    >
      {(_identity) => (
        <iframe
          class="chat-tool-card__preview-frame"
          title={props.title}
          sandbox={sandbox()}
          src={src() ?? undefined}
          style={{
            height: props.content.preferredHeight
              ? `${props.content.preferredHeight}px`
              : undefined,
          }}
        />
      )}
    </Show>
  );
}

export function SidebarPanel(props: SidebarPanelProps) {
  const title = () => sidebarTitle(props.content, props.showingRawText);
  const fillHost = () =>
    ["file", "markdown", "attachment", "session-diff"].includes(props.content?.kind ?? "");
  // Text attachments initialize their own asynchronously loaded Markdown.
  const markdownPresented = createMemo(() => props.content?.kind !== "attachment");
  const markdownRef = markdownBlocksRef(markdownPresented);
  return (
    <div
      class={fillHost() ? "sidebar-panel-host--fill" : ""}
      ref={markdownRef}
      onClick={(event) => props.onClick(event)}
      onKeyDown={(event) => props.onKeydown(event)}
    >
      <div
        class="sidebar-panel"
        data-file-session-key={
          props.content?.kind === "markdown"
            ? props.content.fileLinkSessionKey
            : props.content?.kind === "file"
              ? props.content.sessionFileSource?.sessionKey
              : undefined
        }
      >
        <Show when={!props.embedded}>
          <div class="sidebar-header">
            <div class="sidebar-title">{title()}</div>
            <div class="sidebar-header__actions">
              <openclaw-tooltip prop:content={t("chat.detailPanel.close")}>
                <button
                  onClick={() => props.onClose()}
                  class="btn"
                  type="button"
                  aria-label={t("chat.detailPanel.close")}
                >
                  <Icon name="x" />
                </button>
              </openclaw-tooltip>
            </div>
          </div>
        </Show>
        <div class="sidebar-content">
          <Show
            when={!props.error}
            fallback={
              <>
                <LazyViewError
                  error={props.error}
                  stale={isStaleChunkImportError(props.error)}
                  onRetry={props.onRetry}
                />
                <Show when={props.content?.kind === "file" || props.content?.rawText?.trim()}>
                  <RawButton onClick={props.onViewRawText} style={{ "margin-top": "12px" }} />
                </Show>
              </>
            }
          >
            <Switch fallback={<div class="muted">{t("chat.detailPanel.noContent")}</div>}>
              <Match when={props.content?.kind === "mcp-app" ? props.content : undefined}>
                {(content) => <McpAppPanel launch={content().launch} />}
              </Match>
              <Match when={props.content?.kind === "file" ? props.content : undefined}>
                {(content) => (
                  <SidebarFile
                    content={content()}
                    onViewRawText={props.onViewRawText}
                    controls={props.fileView}
                    runtime={props.attachmentRuntime}
                  />
                )}
              </Match>
              <Match when={props.content?.kind === "session-diff" ? props.content : undefined}>
                {(content) => (
                  <SessionDiffPanel
                    owner={content().owner}
                    loader={content().load}
                    loadFileText={content().loadFileText ?? null}
                    execNode={props.fileView?.execNode ?? null}
                    openFile={content().openFile ?? null}
                    revealFile={props.fileView?.onReveal ?? null}
                  />
                )}
              </Match>
              <Match
                when={
                  props.content?.kind === "canvas" || props.content?.kind === "image"
                    ? props.content.kind
                    : undefined
                }
                keyed
              >
                {(kind) => (
                  <div class="chat-tool-card__preview" data-kind={kind}>
                    <div class="chat-tool-card__preview-panel" data-side="front">
                      <Show when={props.content?.kind === "canvas" ? props.content : undefined}>
                        {(content) => (
                          <CanvasPreview
                            content={content()}
                            title={title()}
                            canvasPluginSurfaceUrl={props.canvasPluginSurfaceUrl}
                            embedSandboxMode={props.embedSandboxMode}
                            allowExternalEmbedUrls={props.allowExternalEmbedUrls}
                          />
                        )}
                      </Show>
                      <Show when={props.content?.kind === "image" ? props.content : undefined}>
                        {(content) => (
                          <button
                            type="button"
                            class="chat-tool-card__preview-image-button"
                            aria-label={t("chat.imageLightbox.open", { title: title() })}
                            onClick={() =>
                              openResolvedImage(props.onOpenImage, content().src, title())
                            }
                          >
                            <img
                              class="chat-tool-card__preview-image"
                              src={content().src}
                              alt={title()}
                              style={{
                                display: "block",
                                "max-width": "100%",
                                height: "auto",
                                "border-radius": "8px",
                              }}
                            />
                          </button>
                        )}
                      </Show>
                    </div>
                    <Show when={props.content?.rawText?.trim()}>
                      <div style={{ "margin-top": "12px" }}>
                        <RawButton onClick={props.onViewRawText} />
                      </div>
                    </Show>
                  </div>
                )}
              </Match>
              <Match when={props.content?.kind === "attachment" ? props.content : undefined}>
                {(content) => (
                  <div class="sidebar-attachment-preview">
                    <SidebarAttachment
                      content={content()}
                      onRequestUpdate={props.onAttachmentUpdate}
                      runtime={props.attachmentRuntime}
                      embedSandboxMode={props.embedSandboxMode ?? "scripts"}
                      download={props.attachmentDownload}
                    />
                  </div>
                )}
              </Match>
              <Match when={props.content?.kind === "markdown" ? props.content : undefined}>
                {(content) => (
                  <section class="sidebar-markdown-shell">
                    <div class="sidebar-markdown-shell__toolbar">
                      <div class="sidebar-markdown-shell__intro">
                        <div class="sidebar-markdown-shell__eyebrow">
                          <Icon name="scrollText" />
                          <span>
                            {t(
                              props.showingRawText
                                ? "chat.detailPanel.viewSource"
                                : "chat.detailPanel.renderedMarkdown",
                            )}
                          </span>
                        </div>
                        <Show when={!props.showingRawText}>
                          <div class="sidebar-markdown-shell__hint">
                            {t("chat.detailPanel.renderedMarkdownHint")}
                          </div>
                        </Show>
                      </div>
                      <Show when={!props.showingRawText}>
                        <RawButton onClick={props.onViewRawText} class="btn btn--sm" />
                      </Show>
                    </div>
                    <Show
                      when={content().content.trim()}
                      fallback={
                        <div class="sidebar-markdown-empty">
                          {t("chat.detailPanel.noPreviewableMarkdown")}
                        </div>
                      }
                    >
                      <MarkdownHtml
                        as="article"
                        class="sidebar-markdown-reader sidebar-markdown"
                        dir={detectTextDirection(content().content)}
                        markdown={content().content}
                        options={{
                          codeBlockInteraction: "interactive",
                          fileLinks: true,
                          githubRepo: props.githubRepo ?? null,
                          githubRepositories: props.githubRepositories,
                          interactiveImages: props.onOpenImage !== undefined,
                          sessionLinks: true,
                        }}
                      />
                    </Show>
                  </section>
                )}
              </Match>
            </Switch>
          </Show>
        </div>
      </div>
    </div>
  );
}

type SidebarNavigationCallbacks = {
  basePath: string;
  onOpenImage?: ((item: ImageLightboxItem) => void) | null;
  onOpenSessionLink?: ((target: SessionLinkTarget) => void) | null;
  onOpenWorkspaceFile?: ((target: MarkdownFileLinkTarget) => void) | null;
};

export function handleSidebarClick(event: MouseEvent, callbacks: SidebarNavigationCallbacks) {
  if (openInlineChatImage(event, callbacks.onOpenImage ?? undefined)) {
    return;
  }
  handleMarkdownCodeBlockClick(event);
  const target = markdownFileLinkFromEvent(event);
  if (target) {
    callbacks.onOpenWorkspaceFile?.(target);
    return;
  }
  const sessionTarget = markdownSessionLinkFromEvent(event, callbacks.basePath);
  if (sessionTarget && shouldHandleNavigationClick(event)) {
    event.preventDefault();
    callbacks.onOpenSessionLink?.(sessionTarget);
  }
}

export function handleSidebarKeydown(event: KeyboardEvent, callbacks: SidebarNavigationCallbacks) {
  const target = markdownFileLinkFromKeyboardEvent(event);
  if (target) {
    callbacks.onOpenWorkspaceFile?.(target);
    return;
  }
  const sessionTarget = markdownSessionLinkFromKeyboardEvent(event, callbacks.basePath);
  if (sessionTarget) {
    callbacks.onOpenSessionLink?.(sessionTarget);
  }
}
