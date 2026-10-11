import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyToMode } from "../../config/types.js";

export function isSingleUseReplyToMode(mode: ReplyToMode): boolean {
  return mode === "first" || mode === "batched";
}

export function createReplyReferencePlanner(options: {
  replyToMode: ReplyToMode;
  /** Existing thread/reference id (preferred when allowed by replyToMode). */
  existingId?: string;
  /** Id to start a new thread/reference when allowed (e.g., parent message id). */
  startId?: string;
  /** Disable reply references entirely (e.g., when posting inside a new thread). */
  allowReference?: boolean;
  hasReplied?: boolean;
}) {
  let hasReplied = options.hasReplied ?? false;
  const allowReference = options.allowReference !== false;
  const existingId = normalizeOptionalString(options.existingId);
  const startId = normalizeOptionalString(options.startId);

  const resolve = (): string | undefined => {
    if (
      !allowReference ||
      options.replyToMode === "off" ||
      (isSingleUseReplyToMode(options.replyToMode) && hasReplied)
    ) {
      return undefined;
    }
    return existingId ?? startId;
  };

  return {
    /** Read the next reference without consuming the first-reply slot. */
    peek: resolve,
    use() {
      const id = resolve();
      if (id) {
        hasReplied = true;
      }
      return id;
    },
    /** Mark a reply sent even when it used no reference. */
    markSent() {
      hasReplied = true;
    },
    hasReplied: () => hasReplied,
  };
}
