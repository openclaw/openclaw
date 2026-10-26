import type { JSX } from "@solidjs/web";
import { Show, createMemo } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatImageActions } from "./chat-image-actions.tsx";
import { imageTitle } from "./chat-image-presentation.ts";
import {
  MIN_CHAT_IMAGE_PREVIEW_WIDTH,
  resolveChatImagePreviewSize,
} from "./chat-image-preview-size.ts";
import {
  AssistantAttachmentStatusCard,
  type AssistantAttachmentStatusCardProps,
} from "./chat-message-attachment-status-solid.tsx";
import { openMessageImage, readImageOriginalBlob } from "./chat-message-image-open.ts";
import { isLocalAssistantAttachmentSource } from "./chat-message-local-media.ts";
import type { ImageBlock, ImageRenderOptions } from "./chat-message-media.ts";

export type ImagePresentation = {
  image: ImageBlock;
  key?: symbol;
  managed: boolean;
  originalUnavailable?: boolean;
  previewUrl?: string;
  previewSize?: ReturnType<typeof resolveChatImagePreviewSize>;
  state?: "loading" | "unavailable";
  actions?: Pick<AssistantAttachmentStatusCardProps, "path" | "onAllow" | "onRetry" | "onOpen">;
  reason?: string;
};

export function ImageFrame(props: {
  model: ImagePresentation;
  presentation: {
    observeFrame: (element: Element | undefined) => void;
    admit: () => void;
    renderPreviewElement: (image: ImageBlock, url: string, title: string) => HTMLImageElement;
  };
  options: ImageRenderOptions;
}): JSX.Element {
  const image = () => props.model.image;
  const title = () => imageTitle(image());
  const compact = () => props.model.state === "unavailable";
  const pending = () => props.model.state === "loading";
  const loadOriginal = () => readImageOriginalBlob(image(), props.options);
  // Native previews use the viewer’s file controls. Show their inline menu only
  // when a failed preview cannot open that viewer, never over retained pixels.
  const hasFileActions = () =>
    !props.model.originalUnavailable &&
    (props.model.managed || (compact() && isLocalAssistantAttachmentSource(image().url ?? "")));
  // Decode and upload receipts replace the temporary fallback without remounting the image.
  const dimensions = createMemo(
    () => props.model.previewSize ?? resolveChatImagePreviewSize(image()),
  );
  const smallPreview = () => !compact() && (dimensions().width < 80 || dimensions().height < 32);
  return (
    <span
      ref={props.presentation.observeFrame}
      class={[
        "chat-image-frame chat-image-frame--image",
        {
          "chat-image-frame--managed": props.model.managed,
          "chat-image-frame--small": smallPreview(),
          "chat-image-frame--small-actions": smallPreview() && hasFileActions(),
          "chat-image-frame--compact": compact(),
          "chat-image-frame--compact-actions": compact() && hasFileActions(),
        },
      ]}
      style={{
        "--chat-image-width": `${compact() ? Math.max(MIN_CHAT_IMAGE_PREVIEW_WIDTH, dimensions().width) : dimensions().width}px`,
        "--chat-image-ratio": compact() ? "auto" : `${dimensions().width} / ${dimensions().height}`,
      }}
      aria-busy={pending() ? "true" : "false"}
      role={pending() ? "status" : undefined}
      aria-label={pending() ? t("common.loading") : undefined}
    >
      <Show
        when={!compact()}
        fallback={
          <AssistantAttachmentStatusCard
            label={image().fileName ?? image().alt ?? t("chat.imageLightbox.untitled")}
            badge={t("chat.attachments.unavailable")}
            reason={props.model.reason}
            {...props.model.actions}
          />
        }
      >
        <span class="chat-image-surface">
          <button
            type="button"
            class="chat-message-image-button"
            aria-label={t("chat.imageLightbox.open", { title: title() })}
            aria-disabled={props.model.previewUrl ? undefined : "true"}
            onFocus={() => props.presentation.admit()}
            onClick={(event) => {
              event.stopPropagation();
              if (props.model.previewUrl) {
                openMessageImage(image(), props.model.previewUrl, props.options);
              } else {
                props.presentation.admit();
              }
            }}
          >
            <Show
              when={props.model.previewUrl}
              fallback={<span class="chat-image-skeleton skeleton" aria-hidden="true" />}
            >
              {(url) => <>{props.presentation.renderPreviewElement(image(), url(), title())}</>}
            </Show>
          </button>
        </span>
      </Show>
      <Show when={!pending() && hasFileActions()}>
        <ChatImageActions
          title={title()}
          readOriginalBlob={loadOriginal}
          overlay={!compact() && !smallPreview()}
        />
      </Show>
    </span>
  );
}
