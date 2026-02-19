import { resolveAgentModelPrimary } from "../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../agents/identity.js";
import { resolveModelRefFromString } from "../agents/model-selection.js";
import {
  extractShortModelName,
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
  // Pre-populate model from the configured primary model so that {model} resolves
  // in code paths (heartbeat, cron, message tool) that never fire onModelSelected. (#20826)
  const configuredModel = resolveAgentModelPrimary(cfg, agentId);
  const parsedModel = configuredModel
    ? resolveModelRefFromString({ modelRef: configuredModel, defaultProvider: undefined })
    : undefined;
  const prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(cfg, agentId),
    ...(parsedModel
      ? {
          provider: parsedModel.provider,
          model: extractShortModelName(parsedModel.model),
          modelFull: `${parsedModel.provider}/${parsedModel.model}`,
        }
      : {}),
  };

  const onModelSelected = (ctx: ModelSelectionContext) => {
    // Mutate the object directly instead of reassigning to ensure closures see updates.
    prefixContext.provider = ctx.provider;
    prefixContext.model = extractShortModelName(ctx.model);
    prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
    prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
  };

  return {
    prefixContext,
    responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId, {
      channel: params.channel,
      accountId: params.accountId,
    }).responsePrefix,
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
