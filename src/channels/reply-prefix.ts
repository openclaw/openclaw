import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../agents/identity.js";
import {
  extractShortModelName,
  resolveModelEmoji,
  resolveThinkEmoji,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";

type ModelSelectionContext = Parameters<NonNullable<GetReplyOptions["onModelSelected"]>>[0];

export type ReplyPrefixContextBundle = {
  prefixContext: ResponsePrefixContext;
  responsePrefix?: string;
  responsePrefixContextProvider: () => ResponsePrefixContext;
  onModelSelected: (ctx: ModelSelectionContext) => void;
};

export type ReplyPrefixOptions = Pick<
  ReplyPrefixContextBundle,
  "responsePrefix" | "responsePrefixContextProvider" | "onModelSelected"
>;

export function createReplyPrefixContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixContextBundle {
  const { cfg, agentId } = params;
  const prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(cfg, agentId),
  };

  const effectiveMessages = resolveEffectiveMessagesConfig(cfg, agentId, {
    channel: params.channel,
    accountId: params.accountId,
  });

  const onModelSelected = (ctx: ModelSelectionContext) => {
    const shortModel = extractShortModelName(ctx.model);
    const thinkLevel = ctx.thinkLevel ?? "off";
    // Mutate the object directly instead of reassigning to ensure closures see updates.
    prefixContext.provider = ctx.provider;
    prefixContext.model = shortModel;
    prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
    prefixContext.thinkingLevel = thinkLevel;
    prefixContext.modelEmoji = resolveModelEmoji(
      effectiveMessages.modelEmojiMap,
      shortModel,
      `${ctx.provider}/${ctx.model}`,
      ctx.provider,
    );
    prefixContext.thinkEmoji = resolveThinkEmoji(effectiveMessages.thinkEmoji, thinkLevel);
  };

  return {
    prefixContext,
    responsePrefix: effectiveMessages.responsePrefix,
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected,
  };
}

export function createReplyPrefixOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixOptions {
  const { responsePrefix, responsePrefixContextProvider, onModelSelected } =
    createReplyPrefixContext(params);
  return { responsePrefix, responsePrefixContextProvider, onModelSelected };
}
