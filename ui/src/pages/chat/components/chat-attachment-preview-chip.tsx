import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { attachmentAdmissionRef } from "./chat-attachment-admission-ref.ts";
import "../../../styles/chat/selection-annotations.css";

export type AttachmentChipRemoval = {
  label: string;
  onRemove: (event: Event) => void;
  disabled: boolean;
};

export function AttachmentPreviewChip(props: {
  label: string;
  icon: JSX.Element;
  onClick?: () => void;
  onReveal?: () => void;
  removal?: AttachmentChipRemoval;
  elementRef?: (element: Element | undefined) => void;
}) {
  const ref = attachmentAdmissionRef(() => props.elementRef);
  const label = () => (
    <>
      <span aria-hidden="true">{props.icon}</span>
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
        <button type="button" class="chat-attachment-file chat-selection-annotations__trigger">
          {label()}
        </button>
      </Show>
      <Show when={props.removal}>
        {(removal) => (
          <button
            type="button"
            class="chat-selection-annotations__remove"
            aria-label={removal().label}
            disabled={removal().disabled}
            onClick={(event) => removal().onRemove(event)}
          >
            <Icon name="x" />
          </button>
        )}
      </Show>
    </span>
  );
}
