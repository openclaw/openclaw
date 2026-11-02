import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { attachmentAdmissionRef } from "./chat-attachment-admission-ref.ts";
import { AttachmentRemove } from "./chat-attachment-file.tsx";
import "../../../styles/chat/selection-annotations.css";

export function AttachmentPreviewChip(props: {
  label: string;
  icon: JSX.Element;
  onClick?: () => void;
  onReveal?: () => void;
  removal?: {
    label: string;
    onRemove: (event: Event) => void;
    disabled: boolean;
  };
  elementRef?: (element: Element | undefined) => void;
  triggerRef?: JSX.Ref<HTMLButtonElement>;
}) {
  const ref = attachmentAdmissionRef(() => props.elementRef);
  const label = () => (
    <>
      <span class="chat-attachment-preview-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span
        class={{
          "chat-selection-annotations__label": Boolean(props.removal),
          "chat-attachment-preview-label": !props.removal,
        }}
        dir="auto"
      >
        {props.label}
      </span>
    </>
  );
  return (
    <span
      ref={ref}
      class="chat-attachment-thumb chat-attachment-thumb--file chat-selection-annotations__chip"
      role={props.removal ? undefined : "button"}
      tabindex={props.removal ? undefined : 0}
      onPointerEnter={() => props.onReveal?.()}
      onFocusIn={() => props.onReveal?.()}
      onClick={() => props.onClick?.()}
      onKeyDown={(event) => {
        if (!props.removal && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
    >
      <Show when={props.removal} fallback={<span class="chat-attachment-file">{label()}</span>}>
        <button
          ref={props.triggerRef}
          type="button"
          class="chat-attachment-file chat-selection-annotations__trigger"
          disabled={props.removal?.disabled}
        >
          {label()}
        </button>
      </Show>
      <Show when={props.removal}>
        {(removal) => (
          <AttachmentRemove
            label={removal().label}
            disabled={removal().disabled}
            onClick={(event) => removal().onRemove(event)}
          />
        )}
      </Show>
    </span>
  );
}
