import { t } from "../../../i18n/index.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { getDirectAttachmentFilePicker } from "./chat-attachment-picker-policy.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

export type AttachmentInputKind = "file" | "photo" | "camera" | "media";
type AttachmentInputBindings = {
  inputs: Partial<Record<AttachmentInputKind, HTMLInputElement>>;
  camera?: { show(): void };
  props: ChatAttachmentControlsProps;
};
type MountedAttachmentInputs = AttachmentInputBindings & { lifetime: AbortController };

/** One mounted composer supplies its inputs and plus-menu anchor through refs. */
export function createChatAttachmentInputHandle() {
  let bindings: MountedAttachmentInputs | undefined;
  let anchor: HTMLElement | undefined;
  const openNative = (kind: AttachmentInputKind) => {
    const input = bindings?.inputs[kind];
    if (input) {
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
  };
  const openFiles = async (
    current: MountedAttachmentInputs,
    picker: NonNullable<ReturnType<typeof getDirectAttachmentFilePicker>>,
  ) => {
    const props = current.props;
    const reads = props.attachmentReads;
    const signal = props.readSignal ?? reads?.readSignal;
    const lifetime = signal
      ? AbortSignal.any([signal, current.lifetime.signal])
      : current.lifetime.signal;
    const active = () =>
      bindings === current &&
      props.attachmentReads === reads &&
      (props.readSignal ?? reads?.readSignal) === signal &&
      !lifetime.aborted &&
      !props.disabled &&
      !props.imagesOnly &&
      uploadsEnabled(props.uploadConfig);
    if (!active()) {
      return;
    }
    const updatePending = props.onPendingReadsChange;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failureMessage = "chat.attachments.pickerFailed";
    const retired = Promise.withResolvers<null>();
    const stopAbort = listen(lifetime, "abort", () => retired.resolve(null), { once: true });
    updatePending?.(1);
    try {
      // Invoke synchronously in the menu gesture. No accept/type filter: arbitrary
      // documents and provider access must remain available.
      const handles = await Promise.race([
        picker.call(window, { multiple: true }),
        retired.promise,
      ]);
      if (!handles || !active()) {
        return;
      }
      failureMessage = "chat.attachments.readFailed";
      // Providers may resolve at different speeds or lose access. Keep selection
      // order and readable siblings; admission still owns type/size validation.
      const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("File provider timed out")), 15_000);
      });
      const results = await Promise.race([
        Promise.allSettled(
          handles.map(async (handle) => Promise.race([handle.getFile(), expired])),
        ),
        retired.promise,
      ]);
      if (!results || !active()) {
        return;
      }
      const files: File[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          files.push(result.value);
        }
      }
      if (results.some((result) => result.status === "rejected")) {
        showToast({ message: t("chat.attachments.readFailed"), severity: "error" });
      }
      appendChatAttachmentFiles(files, props);
    } catch (error) {
      const cancelled =
        failureMessage === "chat.attachments.pickerFailed" &&
        error instanceof DOMException &&
        error.name === "AbortError";
      if (active() && !cancelled) {
        showToast({ message: t(failureMessage), severity: "error" });
      }
    } finally {
      clearTimeout(timeout);
      stopAbort();
      updatePending?.(-1);
    }
  };
  return {
    bindInputs(next: AttachmentInputBindings) {
      bindings?.lifetime.abort();
      const current = { ...next, lifetime: new AbortController() };
      bindings = current;
      return () => {
        current.lifetime.abort();
        if (bindings === current) {
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
        const picker = getDirectAttachmentFilePicker();
        if (kind === "file" && bindings && !bindings.props.imagesOnly && picker) {
          void openFiles(bindings, picker);
        } else {
          openNative(kind);
        }
      }
    },
    openNative,
  };
}

export type ChatAttachmentInputHandle = ReturnType<typeof createChatAttachmentInputHandle>;
