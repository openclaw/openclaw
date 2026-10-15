import type { JSX } from "@solidjs/web";
import { createEffect, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../styles/chat/selection-annotations.css";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";

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
  let element!: HTMLSpanElement;
  createEffect(
    () => props.elementRef,
    (ref) => {
      ref?.(element);
      return () => ref?.(undefined);
    },
  );
  const label = () => (
    <>
      <span aria-hidden="true">{props.icon}</span>
      <span
        class={
          props.removal ? "chat-selection-annotations__label" : "chat-attachment-preview-label"
        }
        dir="auto"
      >
        {props.label}
      </span>
    </>
  );
  return (
    <span
      ref={(node) => {
        element = node;
      }}
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

function LegacyAttachmentChip(props: {
  label: string;
  icon: unknown;
  onClick?: () => void;
  onReveal?: () => void;
  removal?: AttachmentChipRemoval;
  elementRef?: (element: Element | undefined) => void;
}) {
  return (
    <AttachmentPreviewChip
      label={props.label}
      icon={<LitContent value={props.icon} />}
      onClick={props.onClick}
      onReveal={props.onReveal}
      removal={props.removal}
      elementRef={props.elementRef}
    />
  );
}

export function renderAttachmentChip(options: Parameters<typeof LegacyAttachmentChip>[0]) {
  return solidContent(LegacyAttachmentChip, options);
}
