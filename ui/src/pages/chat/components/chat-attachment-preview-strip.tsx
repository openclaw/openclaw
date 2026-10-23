import { For, Show, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import "../../../components/tooltip.ts";
import type { BrowserAnnotationAttachment, ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { getChatAttachmentPreviewUrl } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { removeDraftAttachment } from "./chat-attachment-draft.ts";
import { AttachmentRemove, CompactAttachmentFile } from "./chat-attachment-file.tsx";
import type { AttachmentPreviewEntry } from "./chat-attachments.tsx";
import { ComposerPastedText } from "./chat-composer-pasted-text.tsx";
import { isPastedTextAttachment } from "./chat-pasted-text.ts";
import { ChatSelectionAnnotations } from "./chat-selection-annotations.tsx";

function AttachmentImage(props: {
  attachment: ChatAttachment;
  alt: string;
  title: string;
  controls: ChatAttachmentControlsProps;
  buttonRef?: (element: HTMLButtonElement) => void;
}) {
  const src = () => getChatAttachmentPreviewUrl(props.attachment);
  return (
    <Show when={src()}>
      {(source) => (
        <Show when={props.controls.onOpenImage} fallback={<img src={source()} alt={props.alt} />}>
          <button
            ref={[props.buttonRef]}
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
  let previewButton: HTMLButtonElement | undefined;
  let removeButton: HTMLButtonElement | undefined;
  onSettled(() => {
    const button = previewButton ?? removeButton;
    return button
      ? props.controls.registerBrowserAnnotationFocus?.(props.attachment.id, button)
      : undefined;
  });
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
          buttonRef={(element) => {
            previewButton = element;
          }}
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
        buttonRef={(element) => {
          removeButton = element;
        }}
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
                  "chat-attachment-thumb--video": att().mimeType.startsWith("video/"),
                  "chat-attachment-thumb--file": !att().mimeType.startsWith("image/"),
                  "chat-attachment-thumb--error": failed(),
                },
              ]}
              aria-busy={reading() && props.entry.preparation !== "offer" ? "true" : "false"}
            >
              {preparing() ? (
                <CompactAttachmentFile
                  attachment={att()}
                  videoPreparation={{
                    state: failed() ? "error" : (props.entry.preparation ?? "offer"),
                    progress: props.entry.progress,
                  }}
                  metadata={
                    props.entry.preparation === "compressing" ? (
                      <span class="chat-attachment-file__type" role="status">
                        {t("chat.attachments.compressing", {
                          progress: String(Math.floor((props.entry.progress ?? 0) * 100)),
                        })}
                      </span>
                    ) : (
                      <span class="chat-attachment-file__type">
                        {failed() && (
                          <span class="sr-only" role="status">
                            {failureLabel()}
                          </span>
                        )}
                        <button
                          type="button"
                          class={[
                            "chat-attachment-compress",
                            { "chat-attachment-compress--retry": failed() },
                          ]}
                          title={failed() ? failureLabel() : t("chat.attachments.compressionHint")}
                          disabled={props.controls.disabled}
                          onClick={() => props.entry.read.compress?.()}
                        >
                          {failed() && <Icon name="refresh" />}
                          <span>
                            {t(
                              failed()
                                ? "chat.attachments.retryCompression"
                                : "chat.attachments.compressToFit",
                            )}
                          </span>
                          {!failed() && <Icon name="chevronRight" />}
                        </button>
                      </span>
                    )
                  }
                />
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
                data-state={preparing() ? "preparation" : props.entry.state}
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

export function AttachmentPreviewStrip(props: {
  entries: readonly AttachmentPreviewEntry[];
  controls: ChatAttachmentControlsProps;
}) {
  return (
    <div class="chat-attachments-preview" ref={useScrollState(true)}>
      <ChatSelectionAnnotations {...props.controls} />
      <For
        each={props.entries.filter(({ attachment }) => !attachment.selectionAnnotation)}
        keyed={(entry) => entry.attachment.id}
      >
        {(entry) => <AttachmentTile entry={entry()} controls={props.controls} />}
      </For>
    </div>
  );
}
