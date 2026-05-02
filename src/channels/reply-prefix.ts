import { resolveAgentIdentity, resolveEffectiveMessagesConfig } from "../agents/identity.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import {
  extractShortModelName,
  hasLateBoundTemplateVariables,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

type ModelSelectionContext = Parameters<NonNullable<GetReplyOptions["onModelSelected"]>>[0];
type ResponseTemplateResolvedContext = Parameters<
  NonNullable<GetReplyOptions["onResponseTemplateContextResolved"]>
>[0];

export type ReplyPrefixContextBundle = {
  prefixContext: ResponsePrefixContext;
  responsePrefix?: string;
  responsePrefixContextProvider: () => ResponsePrefixContext;
  onModelSelected: (ctx: ModelSelectionContext) => void;
  onResponseTemplateContextResolved?: (ctx: ResponseTemplateResolvedContext) => void;
};

export type ReplyPrefixOptions = Pick<
  ReplyPrefixContextBundle,
  | "responsePrefix"
  | "responsePrefixContextProvider"
  | "onModelSelected"
  | "onResponseTemplateContextResolved"
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

  const responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {
    channel: params.channel,
    accountId: params.accountId,
  }).responsePrefix;
  const onResponseTemplateContextResolved = hasLateBoundTemplateVariables(responsePrefix)
    ? (ctx: ResponseTemplateResolvedContext) => {
        Object.assign(prefixContext, ctx);
      }
    : undefined;

  return {
    prefixContext,
    responsePrefix,
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected,
    ...(onResponseTemplateContextResolved ? { onResponseTemplateContextResolved } : {}),
  };
}

export function createReplyPrefixOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixOptions {
  const {
    responsePrefix,
    responsePrefixContextProvider,
    onModelSelected,
    onResponseTemplateContextResolved,
  } = createReplyPrefixContext(params);
  return {
    responsePrefix,
    responsePrefixContextProvider,
    onModelSelected,
    onResponseTemplateContextResolved,
  };
}
