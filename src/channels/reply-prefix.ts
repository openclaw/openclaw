import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../agents/identity.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";

type ModelSelectionContext = Parameters<NonNullable<GetReplyOptions["onModelSelected"]>>[0];

type ReplyPrefixSessionSeed = Pick<SessionEntry, "model" | "modelProvider" | "thinkingLevel">;

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

function applySessionSeedToPrefixContext(
  prefixContext: ResponsePrefixContext,
  sessionSeed?: ReplyPrefixSessionSeed,
): void {
  const rawModel = sessionSeed?.model?.trim();
  const rawProvider = sessionSeed?.modelProvider?.trim();
  const rawThinkingLevel = sessionSeed?.thinkingLevel?.trim();
  if (!rawModel && !rawProvider && !rawThinkingLevel) {
    return;
  }

  let provider = rawProvider;
  let modelFull = rawModel;
  if (!provider && rawModel) {
    const slashIndex = rawModel.indexOf("/");
    if (slashIndex > 0) {
      provider = rawModel.slice(0, slashIndex).trim() || undefined;
      modelFull = rawModel;
    }
  }
  if (provider && rawModel) {
    const providerPrefix = `${provider}/`;
    modelFull = rawModel.toLowerCase().startsWith(providerPrefix.toLowerCase())
      ? rawModel
      : `${provider}/${rawModel}`;
  }

  if (provider) {
    prefixContext.provider = provider;
  }
  if (rawModel) {
    prefixContext.model = extractShortModelName(rawModel);
  }
  if (modelFull) {
    prefixContext.modelFull = modelFull;
  }
  prefixContext.thinkingLevel = rawThinkingLevel || "off";
}

function resolveReplyPrefixSessionSeed(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): ReplyPrefixSessionSeed | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const store = loadSessionStore(storePath);
    return resolveSessionStoreEntry({ store, sessionKey }).existing;
  } catch {
    return undefined;
  }
}

export function createReplyPrefixContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
  sessionKey?: string;
}): ReplyPrefixContextBundle {
  const { cfg, agentId } = params;
  const prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(cfg, agentId),
  };
  applySessionSeedToPrefixContext(
    prefixContext,
    resolveReplyPrefixSessionSeed({
      cfg,
      agentId,
      sessionKey: params.sessionKey,
    }),
  );

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
  sessionKey?: string;
}): ReplyPrefixOptions {
  const { responsePrefix, responsePrefixContextProvider, onModelSelected } =
    createReplyPrefixContext(params);
  return { responsePrefix, responsePrefixContextProvider, onModelSelected };
}
