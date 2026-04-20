import { resolveAgentIdentity, resolveEffectiveMessagesConfig } from "../agents/identity.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatTokenCount } from "../utils/usage-format.js";

type ModelSelectionContext = Parameters<NonNullable<GetReplyOptions["onModelSelected"]>>[0];
type ContextUsageInput = Parameters<NonNullable<GetReplyOptions["onContextUsage"]>>[0];

export type ReplyPrefixContextBundle = {
  prefixContext: ResponsePrefixContext;
  responsePrefix?: string;
  responsePrefixContextProvider: () => ResponsePrefixContext;
  onModelSelected: (ctx: ModelSelectionContext) => void;
  onContextUsage: (ctx: ContextUsageInput) => void;
};

export type ReplyPrefixOptions = Pick<
  ReplyPrefixContextBundle,
  "responsePrefix" | "responsePrefixContextProvider" | "onModelSelected" | "onContextUsage"
>;

export function createReplyPrefixContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixContextBundle {
  const { cfg, agentId } = params;
  const prefixContext: ResponsePrefixContext = {
    identityName: normalizeOptionalString(resolveAgentIdentity(cfg, agentId)?.name),
  };

  const onModelSelected = (ctx: ModelSelectionContext) => {
    // Mutate the object directly instead of reassigning to ensure closures see updates.
    prefixContext.provider = ctx.provider;
    prefixContext.model = extractShortModelName(ctx.model);
    prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
    prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
  };

  const onContextUsage = (ctx: ContextUsageInput) => {
    const tokens =
      typeof ctx.tokens === "number" && Number.isFinite(ctx.tokens) && ctx.tokens >= 0
        ? ctx.tokens
        : undefined;
    if (tokens === undefined) {
      return;
    }
    prefixContext.context = formatTokenCount(tokens);
    const window = ctx.contextWindowTokens;
    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
      prefixContext.contextPercent = String(Math.min(100, Math.round((tokens / window) * 100)));
    }
  };

  return {
    prefixContext,
    responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId, {
      channel: params.channel,
      accountId: params.accountId,
    }).responsePrefix,
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected,
    onContextUsage,
  };
}

export function createReplyPrefixOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixOptions {
  const { responsePrefix, responsePrefixContextProvider, onModelSelected, onContextUsage } =
    createReplyPrefixContext(params);
  return {
    responsePrefix,
    responsePrefixContextProvider,
    onModelSelected,
    onContextUsage,
  };
}
