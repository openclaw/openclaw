import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

export function clickComposerInput(target: HTMLElement, selector: string, anchor?: HTMLElement) {
  const composer = target.closest(".agent-chat__composer-shell, .new-session-page__composer");
  const input = composer?.querySelector<HTMLInputElement>(selector);
  if (!input) {
    return;
  }
  // Camera callbacks originate from a display:contents host, not the plus menu.
  const pickerAnchor =
    anchor ?? composer?.querySelector<HTMLElement>(".agent-chat__input-btn--attach");
  if (pickerAnchor) {
    // iOS presents its native upload menu from the input's rendered rectangle.
    // Measure at activation so scrolling, resizing, and the keyboard cannot stale it.
    const rect = pickerAnchor.getBoundingClientRect();
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
  target: HTMLElement,
  value: string,
  anchor?: HTMLElement,
): boolean {
  if (value !== "camera" && value !== "photo" && value !== "file") {
    return false;
  }
  if (value === "camera") {
    target
      .closest(".agent-chat__composer-shell, .new-session-page__composer")
      ?.querySelector("openclaw-chat-camera-capture")
      ?.show();
  } else {
    clickComposerInput(target, `.agent-chat__${value}-input`, anchor);
  }
  return true;
}
