import { lazy, Show } from "solid-js";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

export type ChatCommentAction = {
  id?: string;
  action: "edit" | "delete" | "delete-all";
  anchor?: HTMLElement;
  focusDelete?: (id: string) => void;
};

export function dispatchChatCommentAction(
  event: Event,
  id: string | undefined,
  action: ChatCommentAction["action"],
  context?: Pick<ChatCommentAction, "anchor" | "focusDelete">,
) {
  event.currentTarget?.dispatchEvent(
    new CustomEvent("openclaw-comment-action", {
      bubbles: true,
      composed: true,
      detail: { id, action, ...context },
    }),
  );
}

const ChatSelectionAnnotationRows = lazy(() => import("./chat-selection-annotation-rows.tsx"), {
  export: "ChatSelectionAnnotationRows",
});

export function ChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  return (
    <Show when={props.attachments?.some((attachment) => attachment.selectionAnnotation)}>
      <ChatLazyBoundary>
        <ChatSelectionAnnotationRows {...props} />
      </ChatLazyBoundary>
    </Show>
  );
}
