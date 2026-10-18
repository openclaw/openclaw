import { createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { readBlobAsDataUrl } from "../../../lib/blob-data-url.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { isAbsolutePath } from "../../new-session/path.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";
import type { FileViewControls } from "./chat-file-reader-controls.ts";
import { copyImageToClipboard, convertImageBlobToPng } from "./chat-image-actions.tsx";
import type {
  AttachmentSidebarRuntime,
  FilePreviewSource,
  FileSidebarContent,
  SidebarContent,
} from "./chat-sidebar-content-types.ts";
import { DesktopFileNavigation, SidebarFile, FileAction } from "./chat-sidebar-file-view.tsx";

/** The workspace owns identity and original downloads; this view operates on displayed pixels. */
export function SidebarImage(props: {
  content: Extract<SidebarContent, { kind: "image" }>;
  controls: FileViewControls;
  onEdit?: () => void;
  onViewSource?: () => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
}) {
  const id = createUniqueId();
  const [feedback, setFeedback] = createSignal<"copied" | "failed" | null>(null);
  const [imageError, setImageError] = createSignal(false);
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(feedbackTimer);
  });
  // Pinning a preview can re-derive its presentation object without changing
  // the file or pixels. Async feedback follows that identity, not the wrapper.
  const isCurrentImage = (content: typeof props.content) =>
    !disposed &&
    props.content.src === content.src &&
    props.content.file?.path === content.file?.path &&
    props.content.file?.artifactId === content.file?.artifactId;
  const relativePath = () => {
    const file = props.content.file;
    return file?.root && file.path && !isAbsolutePath(file.path) ? file.path : undefined;
  };
  const copy = async (kind: "image" | "path" | "relative") => {
    const content = props.content;
    const current = () => isCurrentImage(content);
    props.controls.onSelectContent?.();
    let copied = false;
    try {
      if (kind === "image") {
        await copyImageToClipboard(async () => {
          const response = await fetch(content.src);
          const blob = await response.blob();
          if (disposed) {
            throw new Error("Image view closed");
          }
          return blob;
        });
        copied = true;
      } else {
        const path =
          kind === "relative" ? relativePath() : (content.file?.absolutePath ?? content.file?.path);
        if (path) {
          copied = await copyToClipboard(path, current);
        }
      }
    } catch {
      copied = false;
    }
    if (!current()) {
      return;
    }
    setFeedback(copied ? "copied" : "failed");
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => setFeedback(null), copied ? 1500 : 2400);
  };
  const expand = async () => {
    if (!props.onOpenImage) {
      return;
    }
    const content = props.content;
    props.controls.onSelectContent?.();
    setImageError(false);
    try {
      // SVG URLs remain blocked by the native lightbox. Rasterize the displayed
      // image instead of weakening that policy or opening active SVG documents.
      const src =
        content.mimeType === "image/svg+xml"
          ? await readBlobAsDataUrl(
              await convertImageBlobToPng(await (await fetch(content.src)).blob()),
              {
                readError: "Image could not be decoded",
                invalidResultError: "Image could not be decoded",
              },
            )
          : content.src;
      if (isCurrentImage(content) && props.controls.active !== false) {
        props.onOpenImage?.({ src, title: content.title });
      }
    } catch {
      if (isCurrentImage(content)) {
        setImageError(true);
      }
    }
  };
  const Image = () => (
    <img
      src={props.content.src}
      alt={props.content.title}
      onLoad={() => setImageError(false)}
      onError={() => setImageError(true)}
    />
  );
  const copyLabel = () =>
    t(
      feedback() === "copied"
        ? "common.copied"
        : feedback() === "failed"
          ? "chat.imageLightbox.copyFailed"
          : "chat.imageLightbox.copy",
    );
  return (
    <section
      class="sidebar-file-view sidebar-file-view--desktop sidebar-image-view"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
          event.preventDefault();
          event.stopPropagation();
          void copy("image");
        }
      }}
    >
      <div class="sidebar-file-view__path-bar session-panel-rail" data-presentation="desktop">
        <div class="sidebar-file-view__path-field">
          <DesktopFileNavigation
            name={props.content.title}
            path={props.content.file?.path ?? ""}
            workspace={props.controls.workspace}
          />
        </div>
        <div class="sidebar-file-view__actions session-panel-rail__actions">
          <div class="session-panel-rail__group">
            <FileAction
              label={copyLabel()}
              icon={feedback() === "copied" ? "check" : "copy"}
              onClick={() => void copy("image")}
            />
            <Show when={props.content.file?.path}>
              <span class="session-panel-rail__separator" aria-hidden="true" />
              <Menu
                id={`image-copy-${id}`}
                label={t("chat.imageLightbox.actions")}
                panelClass="sidebar-file-view__menu"
                trigger={<Icon name="chevronDown" />}
                triggerClass="session-panel-rail__button sidebar-file-view__action"
                items={[
                  { id: "image", label: t("chat.imageLightbox.copy"), icon: <Icon name="image" /> },
                  {
                    id: "path",
                    label: t("chat.detailPanel.copyPath"),
                    icon: <Icon name="fileText" />,
                  },
                  ...(relativePath()
                    ? [
                        {
                          id: "relative",
                          label: t("chat.detailPanel.copyRelativePath"),
                          icon: <Icon name="folder" />,
                        },
                      ]
                    : []),
                ]}
                onSelect={(item) => {
                  if (item.id === "image" || item.id === "path" || item.id === "relative") {
                    void copy(item.id);
                  }
                }}
              />
            </Show>
          </div>
          <Show when={props.content.file}>
            {(file) => (
              <div class="session-panel-rail__group">
                <Show when={props.onEdit}>
                  {(edit) => (
                    <FileAction
                      label={t("chat.detailPanel.editFile")}
                      icon="pencilLine"
                      onClick={() => edit()()}
                    />
                  )}
                </Show>
                <FileDownloadButton
                  scopeKey={file().artifactId ?? file().path}
                  class="btn btn--sm sidebar-file-view__action session-panel-rail__button"
                  download={(signal) => {
                    props.controls.onSelectContent?.();
                    return file().download(signal);
                  }}
                />
                <Show when={props.onViewSource}>
                  {(source) => (
                    <Menu
                      id={`image-source-${id}`}
                      label={t("chat.detailPanel.moreFileActions")}
                      panelClass="sidebar-file-view__menu"
                      trigger={<Icon name="moreHorizontal" />}
                      triggerClass="session-panel-rail__button sidebar-file-view__action"
                      items={[
                        {
                          id: "source",
                          label: t("chat.detailPanel.viewSource"),
                          icon: <Icon name="codeXml" />,
                        },
                      ]}
                      onSelect={() => source()()}
                    />
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
      <div class="sidebar-file-view__workspace-body">
        <div class="sidebar-image-view__canvas">
          <Show when={props.onOpenImage}>
            <div class="sidebar-image-view__tools">
              <FileAction
                label={t("chat.imageLightbox.open", { title: props.content.title })}
                icon="maximize"
                tooltip={false}
                onClick={() => void expand()}
              />
            </div>
          </Show>
          <Show
            when={props.onOpenImage}
            fallback={
              <div class="sidebar-image-view__image">
                <Image />
              </div>
            }
          >
            <button
              type="button"
              class="sidebar-image-view__image"
              aria-label={t("chat.imageLightbox.open", { title: props.content.title })}
              onClick={() => void expand()}
            >
              <Image />
            </button>
          </Show>
          <Show when={imageError()}>
            <div role="alert">{t("chat.imageLightbox.loadFailed")}</div>
          </Show>
          <Show when={feedback() === "failed"}>
            <div role="alert">{t("chat.imageLightbox.copyFailed")}</div>
          </Show>
        </div>
      </div>
    </section>
  );
}

export function SidebarFileFallback(props: {
  name: string;
  file: FilePreviewSource;
  controls: FileViewControls;
}) {
  return (
    <section class="sidebar-file-view sidebar-file-view--desktop">
      <div class="sidebar-file-view__path-bar session-panel-rail" data-presentation="desktop">
        <div class="sidebar-file-view__path-field">
          <DesktopFileNavigation
            name={props.name}
            path={props.file.path}
            workspace={props.controls.workspace}
          />
        </div>
        <div class="session-panel-rail__actions">
          <div class="session-panel-rail__group">
            <FileDownloadButton
              scopeKey={props.file.artifactId ?? props.file.path}
              download={props.file.download}
              class="btn btn--sm sidebar-file-view__action session-panel-rail__button"
            />
          </div>
        </div>
      </div>
      <div class="sidebar-file-view__workspace-body">
        <PanelEmptyState
          presentation="desktop"
          icon={<Icon name="fileText" />}
          heading={t("chat.attachments.previewUnavailable")}
          description={t("chat.detailPanel.downloadToView")}
          action={
            <FileDownloadButton
              scopeKey={props.file.artifactId ?? props.file.path}
              download={props.file.download}
              class="btn btn--sm"
              showLabel
            />
          }
        />
      </div>
    </section>
  );
}

/** Desktop presentation adapter; the file owner retains editing and mobile source behavior. */
export function SidebarSvgFile(props: {
  content: FileSidebarContent;
  /** The editor owner publishes this buffer even when it retains the file object. */
  source: string;
  controls: FileViewControls;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onViewRawText: () => void;
  runtime: AttachmentSidebarRuntime;
}) {
  const image = createMemo((): Extract<SidebarContent, { kind: "image" }> => ({
    kind: "image",
    title: props.content.name,
    mimeType: "image/svg+xml",
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.source)}`,
    file: props.content.download
      ? {
          path: props.content.path,
          absolutePath: props.content.absolutePath,
          root: props.content.root ?? undefined,
          artifactId: props.content.artifactId,
          download: props.content.download,
        }
      : undefined,
  }));
  const preview = () => props.controls.readingMode === "preview" && !props.controls.editing;
  return (
    <div class="sidebar-svg-file">
      <div class="sidebar-svg-file__view" hidden={!preview()}>
        <SidebarImage
          content={image()}
          controls={props.controls}
          onOpenImage={props.onOpenImage}
          onEdit={props.content.edit ? props.controls.onEdit : undefined}
          onViewSource={() => props.controls.onReadingModeChange?.("highlighted")}
        />
      </div>
      <div class="sidebar-svg-file__view" hidden={preview()}>
        <SidebarFile
          content={props.content}
          controls={props.controls}
          runtime={props.runtime}
          onViewRawText={props.onViewRawText}
        />
      </div>
    </div>
  );
}
