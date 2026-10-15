// Shared camera, photo, and file entry points for chat and New Session.
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

export function clickComposerInput(target: HTMLElement, selector: string, anchor?: HTMLElement) {
  target.closest("details")?.removeAttribute("open");
  const input = target
    .closest(".agent-chat__composer-shell, .new-session-page__composer")
    ?.querySelector<HTMLInputElement>(selector);
  if (!input) {
    return;
  }
  if (anchor) {
    // iOS presents its native upload menu from the input's rendered rectangle.
    // Measure at activation so scrolling, resizing, and the keyboard cannot stale it.
    const rect = anchor.getBoundingClientRect();
    Object.assign(input.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
  input.click();
}

export function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = [...(input.files ?? [])];
  input.value = "";
  appendChatAttachmentFiles(files, props);
}

export function handleChatAttachmentMenuSelection(
  event: Pick<CustomEvent<{ item: { value?: string } }>, "currentTarget" | "detail">,
  anchor?: HTMLElement,
): boolean {
  const value = event.detail.item.value;
  if (value !== "camera" && value !== "photo" && value !== "file") {
    return false;
  }
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    if (value === "camera") {
      target
        .closest(".agent-chat__composer-shell, .new-session-page__composer")
        ?.querySelector("openclaw-chat-camera-capture")
        ?.show();
    } else {
      clickComposerInput(target, `.agent-chat__${value}-input`, anchor);
    }
  }
  return true;
}
