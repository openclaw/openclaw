import { selectAgentHarness } from "../../agents/harness/selection.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveSessionRuntimeOverrideForProvider } from "./agent-runner-execution.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";

export type HarnessSourceVisibleRepliesDefault = "automatic" | "message_tool";

type HarnessDefaultCandidate = {
  provider: string;
  model?: string;
};

function resolveHarnessDefaultChannel(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
}): string | undefined {
  const originatingChannel =
    typeof params.ctx.OriginatingChannel === "string" ? params.ctx.OriginatingChannel : undefined;

  return (
    params.entry?.channel ??
    params.entry?.origin?.provider ??
    originatingChannel ??
    params.ctx.Provider ??
    params.ctx.Surface
  );
}

function resolveHarnessDefaultParentSessionKey(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
}): string | undefined {
  return (
    params.entry?.parentSessionKey ??
    params.ctx.ModelParentSessionKey ??
    params.ctx.ParentSessionKey
  );
}

function resolveTurnModelOverride(
  replyOptions?: Pick<GetReplyOptions, "isHeartbeat" | "heartbeatModelOverride">,
): string | undefined {
  if (replyOptions?.isHeartbeat !== true) {
    return undefined;
  }
  return normalizeOptionalString(replyOptions.heartbeatModelOverride);
}

function resolveChannelModelCandidate(params: {
  aliasIndex: ModelAliasIndex;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  defaultProvider: string;
  entry?: SessionEntry;
  parentSessionKey?: string;
}): HarnessDefaultCandidate | undefined {
  if (!params.cfg.channels?.modelByChannel) {
    return undefined;
  }

  const channel = resolveHarnessDefaultChannel({
    ctx: params.ctx,
    entry: params.entry,
  });
  const channelModelOverride = resolveChannelModelOverride({
    cfg: params.cfg,
    channel,
    groupId: params.entry?.groupId,
    groupChatType: params.entry?.chatType ?? params.ctx.ChatType,
    groupChannel: params.entry?.groupChannel ?? params.ctx.GroupChannel,
    groupSubject: params.entry?.subject ?? params.ctx.GroupSubject,
    parentSessionKey: params.parentSessionKey,
  });
  if (!channelModelOverride) {
    return undefined;
  }

  return resolveModelRefFromString({
    raw: channelModelOverride.model,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  })?.ref;
}

function resolveStoredModelCandidate(params: {
  defaultProvider: string;
  entry?: SessionEntry;
  parentSessionKey?: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
}): HarnessDefaultCandidate | undefined {
  const storedModelRef = resolveStoredModelOverride({
    sessionEntry: params.entry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
    defaultProvider: params.defaultProvider,
  });
  if (!storedModelRef) {
    return undefined;
  }
  return {
    provider: storedModelRef.provider ?? params.defaultProvider,
    model: storedModelRef.model,
  };
}

function resolveModelOverrideCandidate(params: {
  aliasIndex: ModelAliasIndex;
  defaultProvider: string;
  modelOverride?: string;
}): HarnessDefaultCandidate | undefined {
  if (!params.modelOverride) {
    return undefined;
  }
  return resolveModelRefFromString({
    raw: params.modelOverride,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  })?.ref;
}

export function resolveHarnessSourceVisibleRepliesDefault(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  replyOptions?: Pick<GetReplyOptions, "isHeartbeat" | "heartbeatModelOverride">;
}): HarnessSourceVisibleRepliesDefault | undefined {
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return undefined;
  }
  try {
    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: defaultModelRef.provider,
    });
    const parentSessionKey = resolveHarnessDefaultParentSessionKey(params);
    const channelModelCandidate = resolveChannelModelCandidate({
      aliasIndex,
      cfg: params.cfg,
      ctx: params.ctx,
      defaultProvider: defaultModelRef.provider,
      entry: params.entry,
      parentSessionKey,
    });
    const storedModelCandidate = resolveStoredModelCandidate({
      defaultProvider: defaultModelRef.provider,
      entry: params.entry,
      parentSessionKey,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
    });
    const turnModelCandidate = resolveModelOverrideCandidate({
      aliasIndex,
      defaultProvider: defaultModelRef.provider,
      modelOverride: resolveTurnModelOverride(params.replyOptions),
    });
    const resolveCandidateDefault = (candidate: { provider: string; model?: string }) => {
      const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
        provider: candidate.provider,
        entry: params.entry,
      });
      const harness = selectAgentHarness({
        provider: candidate.provider,
        modelId: candidate.model,
        config: params.cfg,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
        agentHarnessRuntimeOverride,
      });
      return harness.deliveryDefaults?.sourceVisibleReplies;
    };
    const selectedModelCandidate =
      turnModelCandidate ?? storedModelCandidate ?? channelModelCandidate;
    if (selectedModelCandidate) {
      return resolveCandidateDefault(selectedModelCandidate);
    }
    const sourceProvider = normalizeOptionalString(
      params.entry?.origin?.provider ?? params.ctx.Provider ?? params.ctx.Surface,
    );
    if (sourceProvider) {
      const sourceDefault = resolveCandidateDefault({ provider: sourceProvider });
      if (sourceDefault) {
        return sourceDefault;
      }
    }
    return resolveCandidateDefault(defaultModelRef);
  } catch (error) {
    logVerbose(
      `dispatch-from-config: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}
