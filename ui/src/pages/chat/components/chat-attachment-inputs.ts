import { bindOverlayAnchor } from "../../../components/overlay-anchor.ts";

export type AttachmentInputKind = "file" | "photo" | "camera" | "media";
type AttachmentInputBindings = {
  inputs: Partial<Record<AttachmentInputKind, HTMLInputElement>>;
  camera?: { show(): void };
};

/** One mounted composer supplies its inputs and plus-menu anchor through refs. */
export function createChatAttachmentInputHandle() {
  let bindings: AttachmentInputBindings | undefined;
  let anchor: HTMLElement | undefined;
  let releaseInputAnchor = () => {};
  const openNative = (kind: AttachmentInputKind) => {
    const input = bindings?.inputs[kind];
    if (input) {
      if (anchor) {
        // iOS uses the input's rectangle. CSS anchors also account for layout containment.
        releaseInputAnchor();
        releaseInputAnchor = bindOverlayAnchor(input, anchor);
        input.style.display = "block";
      }
      input.click();
    }
  };
  return {
    bindInputs(next: AttachmentInputBindings) {
      bindings = next;
      return () => {
        if (bindings === next) {
          releaseInputAnchor();
          bindings = undefined;
        }
      };
    },
    bindAnchor(next: HTMLElement | undefined) {
      anchor = next;
      return () => {
        if (anchor === next) {
          releaseInputAnchor();
          anchor = undefined;
        }
      };
    },
    open(kind: AttachmentInputKind, dismiss?: () => boolean) {
      if (kind !== "camera") {
        const input = bindings?.inputs[kind];
        if (!input || !input.isConnected || input.disabled) {
          return false;
        }
      } else if (!bindings?.camera) {
        return false;
      }
      if (dismiss && !dismiss()) {
        return false;
      }
      if (kind === "camera") {
        bindings?.camera?.show();
      } else {
        openNative(kind);
      }
      return true;
    },
    openNative,
  };
}

export type ChatAttachmentInputHandle = ReturnType<typeof createChatAttachmentInputHandle>;
