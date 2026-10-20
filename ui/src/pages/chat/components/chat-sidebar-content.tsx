import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, Match, onCleanup, refresh, Show, Switch } from "solid-js";
import { formatFencedCodeBlock } from "../../../../../src/shared/markdown-code.js";
import { isStaleChunkImportError } from "../../../app/stale-chunk-reload.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import { createMarkdownRef } from "../../../components/markdown-dom-ref.ts";
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
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import "../../../components/tooltip.ts";
import { McpAppPanel } from "../../../components/solid/mcp-app-panel.tsx";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { createCanvasFramePresentation } from "../../../lib/chat/canvas-frame-presentation.ts";
import {
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { isSvgImageMediaPath } from "../../../lib/media-file-extension.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { AttachmentStateCard, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import "./chat-audio-player.tsx";
import {
  isCrossOriginHttpSource,
  safeAttachmentHref,
  safePlainTextAttachmentHref,
  safeMediaAttachmentHref,
} from "./chat-attachment-href.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";
import "./chat-video-player.tsx";
import { openInlineChatImage } from "./chat-image-lightbox.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import { ChatPdfPreview, isPdfAttachment } from "./chat-pdf-preview.tsx";
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
  runtime: AttachmentSidebarRuntime;
  embedSandboxMode: EmbedSandboxMode;
  download?: { pending: boolean; error: string | null; onDownload: () => void };
};

function prepareAttachment(input: SidebarAttachmentProps, onSourceChange: () => void) {
  const content = input.content;
  const resolution = content.resolveSource?.(onSourceChange, input.runtime);
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
  const sourceChanged = () => void refresh(model);
  let resolver: SidebarAttachmentProps["content"]["resolveSource"];
  let identity: string | undefined;
  const model = createMemo(() => {
    const nextResolver = props.content.resolveSource;
    const nextIdentity = props.content.sourceIdentity ?? props.content.src;
    if (resolver !== nextResolver || identity !== nextIdentity) {
      releaseChatMediaResourceOwner(sourceChanged);
      resolver = nextResolver;
      identity = nextIdentity;
    }
    return prepareAttachment(props, sourceChanged);
  });
  onCleanup(() => releaseChatMediaResourceOwner(sourceChanged));
  const mediaProps = () => ({
    "prop:sourceIdentity": props.content.sourceIdentity ?? props.content.src ?? model().src ?? "",
    "prop:label": props.content.title,
    "prop:mimeType": props.content.mimeType ?? "",
    "prop:playback": model().source?.playback ?? props.content.playback ?? "native",
    "prop:authToken": model().source?.authToken ?? null,
    "prop:sizeBytes": model().source?.sizeBytes ?? props.content.sizeBytes,
  });
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
        <ChatPdfPreview
          src={model().src ?? ""}
          sourceIdentity={model().sourceIdentity}
          label={props.content.title}
          mimeType={props.content.mimeType ?? ""}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
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
          actions={props.content.renderActions?.()}
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
          {...mediaProps()}
          prop:mediaWidth={model().source?.width ?? props.content.width}
          prop:mediaHeight={model().source?.height ?? props.content.height}
        />
      </Match>
      <Match when={!model().src || model().imagePreview}>
        <AttachmentStateCard
          kind={model().kind}
          label={props.content.title}
          mimeType={props.content.mimeType ?? undefined}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
          downloadHref={model().src ?? undefined}
          downloadPending={model().pending}
          imagePreview={Boolean(model().imagePreview)}
          previewRatio={model().ratio}
          error={model().error}
          onRetry={model().retry}
        />
      </Match>
      <Match when={model().kind === "audio"}>
        <openclaw-chat-audio-player
          prop:src={model().src ?? ""}
          {...mediaProps()}
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
      return (
        content.fileDownload?.name ??
        t(showingRawText ? "chat.detailPanel.viewSource" : "chat.detailPanel.markdownPreview")
      );
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
  let initialized = false;
  const presentation = createCanvasFramePresentation(
    () => `${sandbox()}\0${props.content.entryUrl ?? ""}\0${src() ? 1 : 0}`,
    src,
    () => initialized,
  );
  return (
    <Show when={presentation.identity()} keyed>
      {(_identity) => (
        <iframe
          ref={() => {
            initialized = false;
          }}
          onLoad={() => {
            initialized = true;
          }}
          class="chat-tool-card__preview-frame"
          title={props.title}
          sandbox={sandbox()}
          src={presentation.src()}
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
  return (
    <div
      class={{ "sidebar-panel-host--fill": fillHost() }}
      ref={markdownBlocksRef(markdownPresented)}
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
                    <Show when={content().fileDownload}>
                      {(file) => (
                        <div class="sidebar-file-view__path-bar">
                          <div class="sidebar-file-view__path-field">
                            <span class="sidebar-file-view__path" title={file().path}>
                              {file().path}
                            </span>
                            <CopyButton
                              text={file().path}
                              idleLabel={t("chat.detailPanel.copyPath")}
                            />
                          </div>
                          <div class="sidebar-file-view__actions">
                            <FileDownloadButton
                              scopeKey={[
                                content().fileLinkSessionKey,
                                file().path,
                                props.attachmentRuntime.connectionEpoch,
                              ].join("\0")}
                              download={(signal) => file().download(signal)}
                              class="btn btn--sm sidebar-file-view__action"
                            />
                            <Show when={props.fileView?.onReveal}>
                              <openclaw-tooltip prop:content={t("chat.detailPanel.showInFiles")}>
                                <button
                                  class="btn btn--sm sidebar-file-view__action"
                                  type="button"
                                  aria-label={t("chat.detailPanel.showInFiles")}
                                  onClick={() => props.fileView?.onReveal?.(file().path)}
                                >
                                  <Icon name="folder" />
                                </button>
                              </openclaw-tooltip>
                            </Show>
                          </div>
                        </div>
                      )}
                    </Show>
                    <Show when={!content().fileDownload}>
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
                    </Show>
                    <Show
                      when={content().content.trim()}
                      fallback={
                        <div class="sidebar-markdown-empty">
                          {t("chat.detailPanel.noPreviewableMarkdown")}
                        </div>
                      }
                    >
                      {(_visible) => {
                        const markdown = createMarkdownRef(() => ({
                          incremental: true,
                          content: toSanitizedMarkdownHtml(content().content, {
                            codeBlockInteraction: "interactive",
                            fileLinks: true,
                            githubRepo: props.githubRepo ?? null,
                            githubRepositories: props.githubRepositories,
                            interactiveImages: props.onOpenImage !== undefined,
                            sessionLinks: true,
                          }),
                        }));
                        return (
                          <article
                            ref={markdown}
                            class="sidebar-markdown-reader sidebar-markdown"
                            dir={detectTextDirection(content().content)}
                          />
                        );
                      }}
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
