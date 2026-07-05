// Shared user-facing compaction notice payload helpers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";

export type CompactionNoticePhase = "start" | "end" | "incomplete" | "skipped";

<<<<<<< HEAD
const COMPACTION_NOTICE_TEXT: Record<CompactionNoticePhase, string> = {
  start: "🧹 Compacting context...",
  end: "🧹 Compaction complete",
  incomplete: "🧹 Compaction incomplete",
  skipped: "🧹 Compaction not needed",
};

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function shouldNotifyUserAboutCompaction(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.compaction?.notifyUser === true;
}

<<<<<<< HEAD
=======
export function formatCompactionNoticeText(phase: CompactionNoticePhase): string {
  switch (phase) {
    case "start":
      return "🧹 Compacting context...";
    case "end":
      return "🧹 Compaction complete";
    case "incomplete":
      return "🧹 Compaction incomplete";
    case "skipped":
      return "🧹 Compaction not needed";
    default: {
      phase satisfies never;
      throw new Error("unknown compaction notice phase");
    }
  }
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function createCompactionNoticePayload(params: {
  phase: CompactionNoticePhase;
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
}): ReplyPayload {
  const payload: ReplyPayload = {
<<<<<<< HEAD
    text: COMPACTION_NOTICE_TEXT[params.phase],
=======
    text: formatCompactionNoticeText(params.phase),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}

export function readCompactionHookMessages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function createCompactionHookNoticePayload(params: {
  messages: string[];
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
}): ReplyPayload | undefined {
  if (params.messages.length === 0) {
    return undefined;
  }
  const payload: ReplyPayload = {
    text: params.messages.join("\n\n"),
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}
