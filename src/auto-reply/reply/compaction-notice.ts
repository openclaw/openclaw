import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { BOUNDED_CONTEXT_NOTICE } from "../../context-engine/transcript-byte-limit.js";
import { formatTokenCount } from "../../utils/token-format.js";
import type { ReplyPayload } from "../types.js";

export type CompactionNoticePhase =
  | "start"
  | "end"
  | "degraded"
  | "incomplete"
  | "skipped"
  | "context_bounded"
  | "memory_flush_degraded";

const COMPACTION_NOTICE_TEXT: Record<CompactionNoticePhase, string> = {
  start: "🧹 Compacting context...",
  end: "🧹 Compaction complete",
  degraded:
    "⚠️ Compaction completed with a degraded summary. Older details, exact identifiers, or pending requests may be missing. Resend important context; /new or a larger model can help.",
  incomplete: "🧹 Compaction incomplete",
  skipped: "🧹 Compaction not needed",
  memory_flush_degraded: "⚠️ Memory maintenance temporarily failed; continuing your reply.",
  context_bounded: BOUNDED_CONTEXT_NOTICE,
};

export function formatCompactionStatus(
  entry?: Pick<SessionEntry, "compactionCount" | "compactionQualityDegraded">,
): string | undefined {
  const count = entry?.compactionCount ?? 0;
  return entry?.compactionQualityDegraded
    ? `${count} · degraded history (details may be lost)`
    : count > 0
      ? String(count)
      : undefined;
}

export function resolveCompactionCompletionNotice(
  result: EmbeddedAgentCompactResult,
  contextBounded: boolean,
): { phase: CompactionNoticePhase; text?: string } {
  const details = parseCompactionDetails(result.result?.details);
  if (details?.qualityDegraded) {
    const text = compactionNoticeText("degraded", details.summaryRefused);
    return {
      phase: "degraded",
      text: contextBounded ? `${text}\n\n${COMPACTION_NOTICE_TEXT.context_bounded}` : text,
    };
  }
  if (contextBounded) {
    return { phase: "context_bounded" };
  }
  const before = result.result?.tokensBefore;
  const after = result.result?.tokensAfter;
  return {
    phase: "end",
    text:
      result.compactionKind === "server-endpoint" && before !== undefined && after !== undefined
        ? `🧹 Server-side compaction complete (${formatTokenCount(before)} → ${formatTokenCount(after)})`
        : undefined,
  };
}

export function formatCompactionModelRef(provider?: string, model?: string): string {
  const parts = [provider, model]
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => value !== undefined);
  return parts.length > 0 ? parts.map((value) => sanitizeForLog(value)).join("/") : "unknown model";
}

export function shouldNotifyUserAboutCompaction(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.compaction?.notifyUser === true;
}

type CompactionNoticeOptions = {
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
};

function createNoticePayload(text: string, params: CompactionNoticeOptions): ReplyPayload {
  const payload: ReplyPayload = {
    text,
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}

function compactionNoticeText(phase: CompactionNoticePhase, summaryRefused?: boolean): string {
  return phase === "degraded" && summaryRefused
    ? "⚠️ Context trimmed because the summarizer refused. Recent turns were kept verbatim; older messages remain in saved history but are outside active context. Resend essential older details to continue."
    : COMPACTION_NOTICE_TEXT[phase];
}

export function createCompactionNoticePayload(
  params: CompactionNoticeOptions & {
    phase: CompactionNoticePhase;
    text?: string;
    summaryRefused?: boolean;
  },
): ReplyPayload {
  return createNoticePayload(
    params.text ?? compactionNoticeText(params.phase, params.summaryRefused),
    params,
  );
}

export function createCompactionHookNoticePayload(
  params: CompactionNoticeOptions & { messages: string[] },
): ReplyPayload | undefined {
  if (params.messages.length === 0) {
    return undefined;
  }
  return createNoticePayload(params.messages.join("\n\n"), params);
}
