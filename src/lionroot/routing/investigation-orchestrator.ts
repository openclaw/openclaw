import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildIMessageInboundContext,
  type IMessageInboundDispatchDecision,
} from "../../imessage/monitor/inbound-processing.js";
import type { IMessagePayload } from "../../imessage/monitor/types.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { InvestigationConfig } from "../config/content-routing-schema.js";
import { formatReplyForChannel } from "../infra/format-reply.js";

const DEFAULT_MAX_STEPS = 5;
const DEFAULT_MAX_DURATION_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_PROMOTION_THRESHOLD = "medium" as const;
const MAX_INVESTIGATION_REPLY_CHARS = 700;
const MAX_PROMOTION_SOURCE_CHARS = 1_500;

type PromotionThreshold = "low" | "medium" | "high";

export type ResolvedInvestigationConfig = {
  enabled: boolean;
  maxSteps: number;
  maxDurationMs: number;
  maxTokens: number;
  promotionThreshold: PromotionThreshold;
  defaultAgentId?: string;
};

export type InvestigationRunResult = {
  replyText: string;
  rawReplyText?: string;
  promotionText?: string;
  shouldPromote: boolean;
  errorSeen: boolean;
};

function normalizePromptBody(text: string): string {
  return text
    .trim()
    .replace(/^\s*(?:investigate|research)\s*:\s*/i, "")
    .replace(/^\s*(?:please\s+)?(?:look|dig)\s+into\s*:\s*/i, "")
    .replace(/^\s*(?:can\s+you\s+|could\s+you\s+)?(?:look|dig)\s+into\s+/i, "")
    .replace(/^\s*(?:can\s+you\s+|could\s+you\s+)?(?:research|investigate)\s+/i, "");
}

function buildInvestigationPrompt(params: {
  bodyText: string;
  maxSteps: number;
  maxTokens: number;
}): string {
  const normalizedBody = normalizePromptBody(params.bodyText) || params.bodyText.trim();
  return [
    "Run a bounded investigation for this inbound iMessage.",
    `Constraints: keep it to at most ${params.maxSteps} concrete investigative steps and about ${params.maxTokens} tokens of final output.`,
    "Infer what the user seems to be evaluating, use available tools only if they materially help, and finish with a direct recommendation.",
    "Reply in this structure:",
    "1. What the user seems to be looking into",
    "2. What you checked or what matters most",
    "3. Recommendation / next action",
    "",
    "User message:",
    normalizedBody,
  ].join("\n");
}

function scorePromotionSignal(text: string): number {
  let score = 0;
  if (text.length >= 180) {
    score += 1;
  }
  if (/\n\s*(?:[-*]|\d+\.)\s+/m.test(text) || text.includes("\n\n")) {
    score += 1;
  }
  if (
    /\b(recommend|recommended|recommendation|next step|next action|should|suggest|worth|trade-?off|better|worse)\b/i.test(
      text,
    )
  ) {
    score += 1;
  }
  return score;
}

export function shouldPromoteInvestigation(params: {
  replyText?: string;
  threshold: PromotionThreshold;
}): boolean {
  const replyText = params.replyText?.trim();
  if (!replyText) {
    return false;
  }
  const score = scorePromotionSignal(replyText);
  if (params.threshold === "low") {
    return score >= 1;
  }
  if (params.threshold === "high") {
    return score >= 3;
  }
  return score >= 2;
}

export function resolveInvestigationConfig(params: {
  contentRoutingDefaultAgentId?: string;
  investigation?: InvestigationConfig;
}): ResolvedInvestigationConfig {
  const investigation = params.investigation;
  return {
    enabled: investigation?.enabled ?? false,
    maxSteps: investigation?.maxSteps ?? DEFAULT_MAX_STEPS,
    maxDurationMs: investigation?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    maxTokens: investigation?.maxTokens ?? DEFAULT_MAX_TOKENS,
    promotionThreshold: investigation?.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD,
    defaultAgentId:
      (typeof investigation?.defaultAgentId === "string" && investigation.defaultAgentId.trim()) ||
      (typeof params.contentRoutingDefaultAgentId === "string" &&
      params.contentRoutingDefaultAgentId.trim()
        ? params.contentRoutingDefaultAgentId.trim()
        : undefined),
  };
}

export function formatInvestigationReply(params: {
  agentId: string;
  rawReplyText?: string;
  errorSeen: boolean;
}): string {
  const rawReplyText = params.rawReplyText?.trim();
  if (!rawReplyText) {
    return params.errorSeen
      ? `${params.agentId}: I looked into it, but the run hit a provider issue before it finished.`
      : `${params.agentId}: I looked into it, but I didn't get a usable result yet.`;
  }
  const compact = formatReplyForChannel(rawReplyText, "compact")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const summary = truncateUtf16Safe(compact, MAX_INVESTIGATION_REPLY_CHARS);
  return `${params.agentId}: ${summary}`;
}

function buildPromotionText(params: {
  agentId: string;
  bodyText: string;
  rawReplyText?: string;
  reason: string;
}): string | undefined {
  const rawReplyText = params.rawReplyText?.trim();
  if (!rawReplyText) {
    return undefined;
  }
  return [
    `🧭 Investigation — ${params.agentId}`,
    "",
    rawReplyText,
    "",
    `Route reason: ${params.reason}`,
    "",
    "Original iMessage:",
    truncateUtf16Safe(params.bodyText.trim(), MAX_PROMOTION_SOURCE_CHARS),
  ].join("\n");
}

export async function runBoundedInvestigation(params: {
  cfg: OpenClawConfig;
  decision: IMessageInboundDispatchDecision;
  message: IMessagePayload;
  bodyText: string;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  remoteHost?: string;
  media: {
    path?: string;
    type?: string;
    paths?: string[];
    types?: Array<string | undefined>;
  };
  accountInfo: { accountId: string; config: { blockStreaming?: boolean } };
  investigation: ResolvedInvestigationConfig;
  reason: string;
}): Promise<InvestigationRunResult> {
  const { ctxPayload } = buildIMessageInboundContext({
    cfg: params.cfg,
    decision: params.decision,
    message: params.message,
    previousTimestamp: undefined,
    remoteHost: params.remoteHost,
    historyLimit: params.historyLimit,
    groupHistories: params.groupHistories,
    media: params.media,
  });

  ctxPayload.BodyForAgent = buildInvestigationPrompt({
    bodyText: params.bodyText,
    maxSteps: params.investigation.maxSteps,
    maxTokens: params.investigation.maxTokens,
  });

  let firstReplyText = "";
  let finalReplyText = "";
  let errorSeen = false;

  const dispatcher = createReplyDispatcher({
    deliver: async (payload, info) => {
      if (payload.isError) {
        errorSeen = true;
        return;
      }
      const text = payload.text?.trim();
      if (!text) {
        return;
      }
      if (!firstReplyText) {
        firstReplyText = text;
      }
      if (info.kind === "final" && !finalReplyText) {
        finalReplyText = text;
      }
    },
  });

  try {
    await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg: params.cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof params.accountInfo.config.blockStreaming === "boolean"
            ? !params.accountInfo.config.blockStreaming
            : undefined,
        timeoutOverrideSeconds: Math.max(1, Math.ceil(params.investigation.maxDurationMs / 1000)),
      },
    });
  } catch {
    errorSeen = true;
  }

  const rawReplyText = finalReplyText || firstReplyText || undefined;
  const shouldPromote = shouldPromoteInvestigation({
    replyText: rawReplyText,
    threshold: params.investigation.promotionThreshold,
  });

  return {
    replyText: formatInvestigationReply({
      agentId: params.decision.route.agentId,
      rawReplyText,
      errorSeen,
    }),
    rawReplyText,
    promotionText: shouldPromote
      ? buildPromotionText({
          agentId: params.decision.route.agentId,
          bodyText: params.bodyText,
          rawReplyText,
          reason: params.reason,
        })
      : undefined,
    shouldPromote,
    errorSeen,
  };
}
