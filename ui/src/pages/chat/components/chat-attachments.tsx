import { createEffect, createMemo, For, Show, useContext } from "solid-js";
import { observeScrollState } from "../../../components/scroll-state-observer.ts";
import "../../../components/tooltip.ts";
import type { BrowserAnnotationAttachment, ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent, SolidContentPresentation } from "../../../lit/solid-content.tsx";
import { getChatAttachmentPreviewUrl } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { removeDraftAttachment } from "./chat-attachment-draft.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import { AttachmentRemove, CompactAttachmentFile } from "./chat-attachment-file.tsx";
import type { ChatAttachmentRead } from "./chat-attachment-reads.ts";
import { ComposerPastedText } from "./chat-composer-pasted-text.tsx";
import { isPastedTextAttachment } from "./chat-pasted-text.ts";
import { renderChatSelectionAnnotations } from "./chat-selection-annotations.ts";

function AttachmentImage(props: {
  attachment: ChatAttachment;
  alt: string;
  title: string;
  controls: ChatAttachmentControlsProps;
}) {
  const src = () => getChatAttachmentPreviewUrl(props.attachment);
  return (
    <Show when={src()}>
      {(source) => (
        <Show when={props.controls.onOpenImage} fallback={<img src={source()} alt={props.alt} />}>
          <button
            type="button"
            class="chat-message-image-button chat-attachment-image-button"
            aria-label={t("chat.imageLightbox.open", { title: props.title })}
            onClick={() => props.controls.onOpenImage?.({ src: source(), title: props.title })}
          >
            <img src={source()} alt={props.alt} />
          </button>
        </Show>
      )}
    </Show>
  );
}

function BrowserAnnotationPreview(props: {
  attachment: ChatAttachment;
  annotation: BrowserAnnotationAttachment;
  controls: ChatAttachmentControlsProps;
}) {
  const identity = () =>
    props.annotation.title.trim() ||
    props.annotation.displayUrl.trim() ||
    props.attachment.fileName ||
    t("chat.attachments.attachedFile");
  return (
    <div
      class="chat-attachment-thumb chat-attachment-thumb--browser-annotation"
      data-attachment-id={props.attachment.id}
      role="group"
      aria-label={`${t("chat.composer.browserAnnotation")}: ${identity()}`}
    >
      <div class="chat-browser-annotation-card__preview">
        <AttachmentImage
          attachment={props.attachment}
          alt={t("chat.composer.browserAnnotationPreview")}
          title={identity()}
          controls={props.controls}
        />
      </div>
      <div class="chat-attachment-file__body chat-browser-annotation-card__body">
        <span
          class="chat-attachment-file__name chat-browser-annotation-card__identity"
          title={identity()}
        >
          {identity()}
        </span>
        <span class="chat-attachment-file__meta chat-browser-annotation-card__meta">
          <span>
            {t(
              props.annotation.markedRegionCount === 1
                ? "chat.composer.browserAnnotationRegion"
                : "chat.composer.browserAnnotationRegions",
              { count: String(props.annotation.markedRegionCount) },
            )}
          </span>
        </span>
      </div>
      <AttachmentRemove
        label={t("chat.composer.removeBrowserAnnotation", { name: identity() })}
        disabled={props.controls.disabled}
        class="chat-attachment-remove chat-browser-annotation-card__remove"
        onClick={() =>
          props.controls.onRemoveAttachment
            ? props.controls.onRemoveAttachment(props.attachment)
            : removeDraftAttachment(props.attachment, props.controls)
        }
      />
    </div>
  );
}

// Keep the live region mounted so changes in the number of files are announced.
export function AttachmentReadStatus(props: { pendingReads: number }) {
  return (
    <div
      class="chat-attachments-status sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {props.pendingReads > 0
        ? t(
            props.pendingReads === 1
              ? "chat.composer.preparingAttachmentCount"
              : "chat.composer.preparingAttachmentsCount",
            { count: String(props.pendingReads) },
          )
        : undefined}
    </div>
  );
}

type AttachmentPreviewEntry = Pick<
  ChatAttachmentRead,
  "attachment" | "state" | "progress" | "preparation" | "errorMessage"
> & {
  read: ChatAttachmentRead;
};

function AttachmentTile(props: {
  entry: AttachmentPreviewEntry;
  controls: ChatAttachmentControlsProps;
}) {
  const att = () => props.entry.attachment;
  const reading = () => props.entry.state === "reading";
  const failed = () => props.entry.state === "error";
  const preparing = () =>
    Boolean(
      props.entry.preparation || (props.entry.errorMessage && att().mimeType.startsWith("video/")),
    );
  const failureLabel = () =>
    t(props.entry.errorMessage ?? "chat.attachments.readFailed", {
      names: att().fileName ?? t("chat.attachments.attachedFile"),
      more: "",
    });
  const removeLabel = () => {
    const name = att().fileName;
    return name?.trim()
      ? t("chat.composer.removeNamedAttachment", { name })
      : t("chat.composer.removeAttachment");
  };
  return (
    <Show
      when={att().browserAnnotation}
      fallback={
        <Show
          when={isPastedTextAttachment(att())}
          fallback={
            <div
              class={[
                "chat-attachment-thumb",
                {
                  "chat-attachment-thumb--preparation": preparing(),
                  "chat-attachment-thumb--file": !att().mimeType.startsWith("image/"),
                  "chat-attachment-thumb--error": failed(),
                },
              ]}
              aria-busy={reading() && props.entry.preparation !== "offer" ? "true" : "false"}
            >
              {preparing() ? (
                <div class="chat-attachment-preparation">
                  <span class="chat-attachment-file__name" title={att().fileName ?? ""}>
                    {att().fileName}
                  </span>
                  {props.entry.preparation === "offer" ? (
                    <button
                      type="button"
                      class="chat-attachment-compress"
                      title={t("chat.attachments.compressionHint")}
                      disabled={props.controls.disabled}
                      onClick={() => props.entry.read.compress?.()}
                    >
                      {t("chat.attachments.compressToFit")}
                    </button>
                  ) : (
                    <span class="chat-attachment-file__meta" role="status">
                      {failed()
                        ? failureLabel()
                        : t("chat.attachments.compressing", {
                            progress: String(Math.floor((props.entry.progress ?? 0) * 100)),
                          })}
                    </span>
                  )}
                </div>
              ) : failed() ? (
                <openclaw-tooltip prop:content={failureLabel()}>
                  <span
                    class="chat-attachment-error"
                    tabindex="0"
                    role="img"
                    aria-label={failureLabel()}
                  >
                    <AttachmentFileIcon
                      filename={att().fileName ?? ""}
                      mimeType={att().mimeType}
                      mode="large-placeholder"
                      unavailable
                    />
                  </span>
                </openclaw-tooltip>
              ) : reading() ? undefined : att().mimeType.startsWith("image/") &&
                getChatAttachmentPreviewUrl(att()) ? (
                <AttachmentImage
                  attachment={att()}
                  alt={att().fileName?.trim() || t("chat.composer.attachmentPreview")}
                  title={att().fileName?.trim() || t("chat.imageLightbox.untitled")}
                  controls={props.controls}
                />
              ) : (
                <CompactAttachmentFile attachment={att()} />
              )}
              <span
                class="chat-attachment-loading"
                data-state={props.entry.preparation === "offer" ? "offer" : props.entry.state}
                data-indeterminate={
                  reading() && props.entry.progress === undefined ? "true" : "false"
                }
                aria-hidden="true"
              >
                <span
                  style={{
                    transform:
                      props.entry.progress === undefined
                        ? undefined
                        : `scaleX(${props.entry.progress})`,
                  }}
                />
              </span>
              <AttachmentRemove
                label={removeLabel()}
                disabled={props.controls.disabled}
                onClick={() => {
                  props.controls.attachmentReads?.remove(props.entry.read);
                  removeDraftAttachment(att(), props.controls);
                }}
              />
            </div>
          }
        >
          <ComposerPastedText attachment={att()} controls={props.controls} />
        </Show>
      }
    >
      {(annotation) => (
        <BrowserAnnotationPreview
          attachment={att()}
          annotation={annotation()}
          controls={props.controls}
        />
      )}
    </Show>
  );
}

export function AttachmentPreview(
  props: ChatAttachmentControlsProps & { readRevision?: number | object },
) {
  const entries = createMemo(() => {
    void props.readRevision;
    const attachments = props.attachments ?? [];
    const reads =
      props.attachmentReads?.project(attachments) ??
      attachments.map((attachment): ChatAttachmentRead => ({ attachment, state: "ready" }));
    return reads.map((read): AttachmentPreviewEntry => ({
      read,
      attachment: read.attachment,
      state: read.state,
      progress: read.progress,
      preparation: read.preparation,
      errorMessage: read.errorMessage,
    }));
  });
  const failures = createMemo(() => entries().filter((entry) => entry.state === "error"));
  return (
    <Show when={entries().length > 0}>
      <AttachmentPreviewStrip entries={entries()} controls={props} />
      <Show when={failures().length > 0}>
        <div class="chat-attachment-failures" role="alert">
          <For each={failures()} keyed={(entry) => entry.attachment.id}>
            {(entry) => (
              <div>
                {t(entry().errorMessage ?? "chat.attachments.readFailed", {
                  names: entry().attachment.fileName ?? t("chat.attachments.attachedFile"),
                  more: "",
                })}
              </div>
            )}
          </For>
          <div class="chat-attachment-failures__help">{t("chat.attachments.retryHelp")}</div>
        </div>
      </Show>
    </Show>
  );
}

function AttachmentPreviewStrip(props: {
  entries: readonly AttachmentPreviewEntry[];
  controls: ChatAttachmentControlsProps;
}) {
  const presented = useContext(SolidContentPresentation);
  let host!: HTMLDivElement;
  createEffect(presented, (active) => {
    if (!active) {
      return undefined;
    }
    const observation = observeScrollState(
      host,
      (state) => {
        for (const key of ["scrollable", "atStart", "atEnd"] as const) {
          host.dataset[key] = String(state[key]);
        }
      },
      true,
    );
    return () => observation.disconnect();
  });
  return (
    <div
      class="chat-attachments-preview"
      ref={(element) => {
        host = element;
      }}
    >
      <LitContent value={renderChatSelectionAnnotations(props.controls)} />
      <For
        each={props.entries.filter(({ attachment }) => !attachment.selectionAnnotation)}
        keyed={(entry) => entry.attachment.id}
      >
        {(entry) => <AttachmentTile entry={entry()} controls={props.controls} />}
      </For>
    </div>
  );
}
