import { createSignal, onCleanup } from "solid-js";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

export type FileCopyAction = "path" | "contents";
export type FileCopyFeedback = Partial<Record<FileCopyAction, "copied" | "failed">>;

export function createFileCopy(
  content: () => SidebarContent | null,
  isConnected: () => boolean,
  currentText?: () => string,
) {
  const [feedback, setFeedback] = createSignal<FileCopyFeedback>({}, { ownedWrite: true });
  const attempts = new Map<FileCopyAction, object>();
  const timers = new Map<FileCopyAction, ReturnType<typeof globalThis.setTimeout>>();
  const clear = () => {
    for (const timer of timers.values()) {
      globalThis.clearTimeout(timer);
    }
    timers.clear();
    attempts.clear();
  };
  onCleanup(clear);

  return {
    feedback,
    reset() {
      clear();
      setFeedback({});
    },
    copy: (action: FileCopyAction) => {
      const file = content();
      if (file?.kind !== "file") {
        return;
      }
      const attempt = {};
      attempts.set(action, attempt);
      const isCurrent = () =>
        attempts.get(action) === attempt && content() === file && isConnected();
      void copyToClipboard(
        action === "path" ? file.path : (currentText?.() ?? file.content),
        isCurrent,
      ).then((copied) => {
        if (!isCurrent()) {
          return;
        }
        setFeedback((value) => ({ ...value, [action]: copied ? "copied" : "failed" }));
        globalThis.clearTimeout(timers.get(action));
        timers.set(
          action,
          globalThis.setTimeout(
            () => {
              timers.delete(action);
              setFeedback((value) => ({ ...value, [action]: undefined }));
            },
            copied ? 1500 : 2000,
          ),
        );
      });
    },
  };
}
