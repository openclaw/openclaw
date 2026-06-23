// Shared user-facing compaction notice payload helpers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";

export type CompactionNoticePhase = "start" | "end" | "incomplete" | "skipped";

export function shouldNotifyUserAboutCompaction(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.compaction?.notifyUser === true;
}

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

export function createCompactionNoticePayload(params: {
  phase: CompactionNoticePhase;
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
}): ReplyPayload {
  const payload: ReplyPayload = {
    text: formatCompactionNoticeText(params.phase),
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
