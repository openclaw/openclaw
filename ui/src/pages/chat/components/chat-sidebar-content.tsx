import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, Match, Show, Switch } from "solid-js";
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
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
  type SessionLinkTarget,
} from "../../../components/markdown-session-links.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { McpAppPanel } from "../../../components/solid/mcp-app-panel.tsx";
import "../../../components/tooltip.ts";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { createCanvasFramePresentation } from "../../../lib/chat/canvas-frame-presentation.ts";
import {
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import type { AttachmentDownload } from "./chat-attachment-download.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";
import type { FileViewControls } from "./chat-file-reader-controls.ts";
import { FileSessionMenu } from "./chat-file-session-menu.tsx";
import { openInlineChatImage } from "./chat-image-lightbox.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { SidebarAttachment } from "./chat-sidebar-attachment.tsx";
import type {
  AttachmentSidebarRuntime,
  ChatDetailPanelContent,
  MobileFileBack,
} from "./chat-sidebar-content-types.ts";
import {
  SidebarFileMobileRail,
  SidebarFileMobileImageControls,
} from "./chat-sidebar-file-mobile.tsx";
import { SidebarFile } from "./chat-sidebar-file-view.tsx";
import { SidebarImage, SidebarSvgFile, SidebarFileFallback } from "./chat-sidebar-image-view.tsx";
import { SessionDiffPanel } from "./session-diff-panel.tsx";

registerEnglishCatalog(registerFilePreviewEnglish);

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
  presentation?: "desktop" | "mobile";
  active?: boolean;
  filePresentation?: "desktop" | "mobile";
  fileBack?: MobileFileBack;
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
  embedded?: boolean;
  attachmentRuntime: AttachmentSidebarRuntime;
  attachmentDownload?: AttachmentDownload;
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
  const mobileMedia = () =>
    props.filePresentation === "mobile" &&
    (props.content?.kind === "image" || props.content?.kind === "attachment");
  const mobileReader = () =>
    mobileMedia() || (props.filePresentation === "mobile" && props.content?.kind === "file");
  const fillHost = () =>
    ["file", "markdown", "attachment", "session-diff", "image"].includes(props.content?.kind ?? "");
  // Text attachments initialize their own asynchronously loaded Markdown.
  const markdownPresented = createMemo(() => props.content?.kind !== "attachment");
  return (
    <div
      class={{
        "sidebar-panel-host--fill": fillHost(),
        "sidebar-panel-host--mobile-reader": mobileReader(),
      }}
      ref={markdownBlocksRef(markdownPresented)}
      onClick={(event) => props.onClick(event)}
      onKeyDown={(event) => props.onKeydown(event)}
    >
      <div
        class="sidebar-panel"
        data-file-entry-id={
          props.content?.kind === "file"
            ? props.content.sessionFileSource?.messageEntryId
            : undefined
        }
        data-file-session-key={
          props.content?.kind === "markdown"
            ? props.content.fileLinkSessionKey
            : props.content?.kind === "file"
              ? props.content.sessionFileSource?.sessionKey
              : undefined
        }
      >
        <Show when={!props.embedded && !mobileReader()}>
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
        <Show when={props.filePresentation === "mobile" && props.content?.kind === "image"}>
          <SidebarFileMobileRail
            name={title()}
            identity={title()}
            back={props.fileBack}
            attachment={props.fileView?.fileAttachment}
          />
        </Show>
        <div class={["sidebar-content", { "sidebar-file-mobile__body": mobileMedia() }]}>
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
                {(content) => (
                  <McpAppPanel
                    launch={content().launch}
                    observeRetirement={content().observeRetirement}
                  />
                )}
              </Match>
              <Match
                when={
                  props.filePresentation === "desktop" &&
                  props.fileView?.imagePreview &&
                  props.content?.kind === "file" &&
                  props.content.mimeType === "image/svg+xml"
                    ? props.content
                    : undefined
                }
              >
                {(content) => (
                  <SidebarSvgFile
                    content={content()}
                    source={props.fileView!.imagePreview!.content}
                    controls={props.fileView!}
                    onOpenImage={props.onOpenImage ?? undefined}
                    onViewRawText={props.onViewRawText}
                    runtime={props.attachmentRuntime}
                  />
                )}
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
                    onScrollPortRef={props.fileView?.onScrollPortRef}
                    mobile={
                      props.presentation === undefined
                        ? (content().presentation?.mobile ?? null)
                        : props.presentation === "mobile"
                    }
                    active={props.active ?? content().presentation?.active ?? true}
                    openFileView={content().presentation?.openFileView ?? null}
                    onOpenMobilePage={content().presentation?.onOpenMobilePage ?? null}
                    scopeRequest={content().presentation?.scopeRequest ?? null}
                    onResult={content().onResult ?? null}
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
                  props.filePresentation === "desktop" &&
                  props.fileView &&
                  props.content?.kind === "image" &&
                  props.content.file &&
                  props.onOpenImage
                    ? props.content
                    : undefined
                }
              >
                {(content) => (
                  <SidebarImage
                    content={content()}
                    controls={props.fileView!}
                    onOpenImage={props.onOpenImage!}
                  />
                )}
              </Match>
              <Match
                when={
                  props.filePresentation === "desktop" &&
                  props.fileView &&
                  (props.content?.kind === "markdown" || props.content?.kind === "attachment") &&
                  props.content.file
                    ? props.content.file
                    : undefined
                }
              >
                {(file) => (
                  <SidebarFileFallback name={title()} file={file()} controls={props.fileView!} />
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
                    <Show
                      when={
                        mobileMedia() && props.onOpenImage && props.content?.kind === "image"
                          ? props.content
                          : undefined
                      }
                    >
                      {(image) => (
                        <SidebarFileMobileImageControls
                          name={title()}
                          onExpand={() =>
                            openResolvedImage(props.onOpenImage, image().src, title())
                          }
                        />
                      )}
                    </Show>
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
                      attachment={props.fileView?.fileAttachment}
                      mobile={props.filePresentation === "mobile"}
                      back={props.fileBack}
                      onOpenImage={props.onOpenImage}
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
                            <span
                              ref={createTextOverflow(() => file().path)}
                              class="sidebar-file-view__path"
                              title={file().path}
                            >
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
                            <Show when={props.fileView?.fileAttachment}>
                              <FileSessionMenu attachment={props.fileView?.fileAttachment} />
                            </Show>
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
                    <Show when={props.filePresentation === "mobile" && content().fileDownload}>
                      {(file) => (
                        <div class="sidebar-file-mobile__fallback-download">
                          <FileDownloadButton
                            scopeKey={[
                              content().fileLinkSessionKey,
                              file().path,
                              props.attachmentRuntime.connectionEpoch,
                            ].join("\0")}
                            download={(signal) => file().download(signal)}
                            class="btn btn--sm"
                            showLabel
                          />
                        </div>
                      )}
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
