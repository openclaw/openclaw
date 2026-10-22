import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

type AttachmentInputKind = "file" | "photo" | "camera";
type AttachmentInputBindings = {
  inputs: Partial<Record<AttachmentInputKind, HTMLInputElement>>;
  camera?: { show(): void };
};

function clickComposerInput(input: HTMLInputElement, anchor?: HTMLElement) {
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

/** One mounted composer supplies its inputs and plus-menu anchor through refs. */
export function createChatAttachmentInputHandle() {
  let bindings: AttachmentInputBindings | undefined;
  let anchor: HTMLElement | undefined;
  const openNative = (kind: AttachmentInputKind) => {
    const input = bindings?.inputs[kind];
    if (input) {
      clickComposerInput(input, anchor);
    }
  };
  return {
    bindInputs(next: AttachmentInputBindings) {
      bindings = next;
      return () => {
        if (bindings === next) {
          bindings = undefined;
        }
      };
    },
    bindAnchor(next: HTMLElement | undefined) {
      anchor = next;
      return () => {
        if (anchor === next) {
          anchor = undefined;
        }
      };
    },
    open(kind: AttachmentInputKind) {
      if (kind === "camera") {
        bindings?.camera?.show();
      } else {
        openNative(kind);
      }
    },
    openNative,
  };
}

export type ChatAttachmentInputHandle = ReturnType<typeof createChatAttachmentInputHandle>;

export function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = [...(input.files ?? [])];
  input.value = "";
  appendChatAttachmentFiles(files, props);
}
