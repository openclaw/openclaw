import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdentity, resolveEffectiveMessagesConfig } from "../agents/identity.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type ModelSelectionContext = Parameters<NonNullable<GetReplyOptions["onModelSelected"]>>[0];

/** Reply prefix callbacks and mutable context shared with provider model selection. */
export type ReplyPrefixContextBundle = {
  /** Mutable context read by response-prefix template rendering. */
  prefixContext: ResponsePrefixContext;
  /** Configured response-prefix template, if any. */
  responsePrefix?: string;
  /** Provider callback that returns the latest prefix context at render time. */
  responsePrefixContextProvider: () => ResponsePrefixContext;
  /** Provider model-selection hook that updates prefix context before first response text. */
  onModelSelected: (ctx: ModelSelectionContext) => void;
};

/** Reply options needed to wire response-prefix rendering into a dispatcher. */
export type ReplyPrefixOptions = Pick<
  ReplyPrefixContextBundle,
  "responsePrefix" | "responsePrefixContextProvider" | "onModelSelected"
>;

/** Creates a response-prefix context bundle for one agent/channel/account route. */
export function createReplyPrefixContext(params: {
  /** Config used to resolve agent identity and effective message settings. */
  cfg: OpenClawConfig;
  /** Agent whose identity and message config should be used. */
  agentId: string;
  /** Optional channel scope for message config overrides. */
  channel?: string;
  /** Optional account scope for message config overrides. */
  accountId?: string;
}): ReplyPrefixContextBundle {
  const { cfg, agentId } = params;
  const prefixContext: ResponsePrefixContext = {
    identityName: normalizeOptionalString(resolveAgentIdentity(cfg, agentId)?.name),
  };

  const onModelSelected = (ctx: ModelSelectionContext) => {
    // Mutate the object directly instead of reassigning so provider callbacks
    // holding responsePrefixContextProvider see model updates before rendering.
    prefixContext.provider = ctx.provider;
    prefixContext.model = extractShortModelName(ctx.model);
    prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
    prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
  };

  return {
    prefixContext,
    // Resolve the prefix template at the same agent/channel/account scope as
    // the reply route, while model facts remain mutable until provider choice.
    responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId, {
      channel: params.channel,
      accountId: params.accountId,
    }).responsePrefix,
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected,
  };
}

/** Creates only the dispatcher-facing reply-prefix options for one route. */
export function createReplyPrefixOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixOptions {
  const { responsePrefix, responsePrefixContextProvider, onModelSelected } =
    createReplyPrefixContext(params);
  return {
    responsePrefix,
    responsePrefixContextProvider,
    onModelSelected,
  };
}
