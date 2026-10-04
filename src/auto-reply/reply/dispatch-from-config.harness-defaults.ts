import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveAgentHarnessDeliveryDefaults } from "../../agents/harness/selection-decision.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import type { ReplyRunVerbosity } from "./get-reply.types.js";

type HarnessSourceVisibleRepliesDefault = "automatic" | "message_tool";

type HarnessDefaultCandidate = {
  provider: string;
  model?: string;
};

export function createShouldEmitVerboseProgress(params: {
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  initialExplicitLevel?: string;
  fallbackLevel: string;
}) {
  let runVerbosity: ReplyRunVerbosity | undefined;
  const resolveCurrentExplicitLevel = () => {
    if (params.sessionKey && params.storePath) {
      try {
        const entry = loadSessionEntryReadOnly({
          ...(params.agentId ? { agentId: params.agentId } : {}),
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          readConsistency: "latest",
          clone: false,
        });
        return normalizeVerboseLevel(entry?.verboseLevel ?? "");
      } catch {
        // Ignore transient store read failures and fall back to the current dispatch snapshot.
      }
    }
    return normalizeVerboseLevel(params.initialExplicitLevel ?? "");
  };
  const resolveLevel = () =>
    runVerbosity?.verboseLevelOverride ??
    resolveCurrentExplicitLevel() ??
    runVerbosity?.resolvedVerboseLevel ??
    normalizeVerboseLevel(params.fallbackLevel) ??
    "off";
  return {
    noteRunVerbosity: (settings: ReplyRunVerbosity) => {
      // A reused queued dispatcher must clear the previous turn's explicit choice.
      runVerbosity = settings;
    },
    shouldEmit: () => resolveLevel() !== "off",
    shouldEmitFull: () => resolveLevel() === "full",
  };
}

export function resolveTurnModelOverride(
  replyOptions: { modelOverride?: string } | undefined,
): string | undefined {
  return normalizeOptionalString(replyOptions?.modelOverride);
}

/**
 * Resolves the configured visible-replies mode plus the guarded harness
 * default. One owner for dispatch and synthetic-turn binding facts: both must
 * derive the same session-stable delivery mode or CLI session bindings
 * ping-pong across turn kinds (#121485).
 */
export function resolveVisibleRepliesPolicy(params: {
  cfg: OpenClawConfig;
  chatType?: string;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  turnModelOverride?: string;
}): {
  configuredVisibleReplies?: "automatic" | "message_tool";
  harnessDefaultVisibleReplies?: "automatic" | "message_tool";
} {
  const configuredVisibleReplies =
    params.chatType === "group" || params.chatType === "channel"
      ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
      : params.cfg.messages?.visibleReplies;
  const harnessDefaultVisibleReplies =
    configuredVisibleReplies === undefined &&
    params.chatType !== "group" &&
    params.chatType !== "channel"
      ? resolveHarnessSourceVisibleRepliesDefault({
          cfg: params.cfg,
          ctx: params.ctx,
          entry: params.entry,
          sessionAgentId: params.sessionAgentId,
          sessionKey: params.sessionKey,
          sessionStore: params.sessionStore,
          turnModelOverride: params.turnModelOverride,
        })
      : undefined;
  return { configuredVisibleReplies, harnessDefaultVisibleReplies };
}

function resolveHarnessSourceVisibleRepliesDefault(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  turnModelOverride?: string;
}): HarnessSourceVisibleRepliesDefault | undefined {
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return undefined;
  }
  try {
    const allowPluginNormalization = params.cfg.plugins?.enabled !== false;
    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
      allowPluginNormalization,
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
      defaultProvider: defaultModelRef.provider,
      allowPluginNormalization,
    });
    const parentSessionKey =
      params.entry?.parentSessionKey ??
      params.ctx.ModelParentSessionKey ??
      params.ctx.ParentSessionKey;
    const channelModelOverride = params.cfg.channels?.modelByChannel
      ? resolveChannelModelOverride({
          cfg: params.cfg,
          channel:
            sessionDeliveryChannel(params.entry) ??
            params.ctx.OriginatingChannel ??
            params.ctx.Provider ??
            params.ctx.Surface,
          groupId: params.entry?.groupId,
          groupChatType: params.entry?.chatType ?? params.ctx.ChatType,
          groupChannel: params.entry?.groupChannel ?? params.ctx.GroupChannel,
          groupSubject: params.entry?.subject ?? params.ctx.GroupSubject,
          parentSessionKey,
          directUserIds: [
            sessionDeliveryOrigin(params.entry)?.nativeDirectUserId,
            sessionDeliveryOrigin(params.entry)?.from,
            sessionDeliveryOrigin(params.entry)?.to,
            params.ctx.OriginatingTo,
            params.ctx.From,
            params.ctx.SenderId,
          ],
        })
      : undefined;
    const channelModelCandidate = channelModelOverride
      ? resolveModelRefFromString({
          raw: channelModelOverride.model,
          cfg: params.cfg,
          agentId: params.sessionAgentId,
          defaultProvider: defaultModelRef.provider,
          allowPluginNormalization,
          aliasIndex,
        })?.ref
      : undefined;
    const storedModelRef = resolveStoredModelOverride({
      loadSessionEntry: (sessionKey) => {
        const agentId = resolveSessionAgentId({
          sessionKey,
          config: params.cfg,
          fallbackAgentId: params.sessionAgentId,
        });
        const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
        return loadSessionEntryReadOnly({
          agentId,
          storePath,
          sessionKey,
          readConsistency: "latest",
          clone: false,
        });
      },
      sessionEntry: params.entry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey,
      defaultProvider: defaultModelRef.provider,
    });
    const storedModelCandidate = storedModelRef
      ? {
          provider: storedModelRef.provider ?? defaultModelRef.provider,
          model: storedModelRef.model,
        }
      : undefined;
    const turnModelCandidate = params.turnModelOverride
      ? resolveModelRefFromString({
          raw: params.turnModelOverride,
          cfg: params.cfg,
          agentId: params.sessionAgentId,
          defaultProvider: defaultModelRef.provider,
          allowPluginNormalization,
          aliasIndex,
        })?.ref
      : undefined;
    const resolveCandidateDefault = (candidate: HarnessDefaultCandidate) => {
      const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
        provider: candidate.provider,
        entry: params.entry,
        cfg: params.cfg,
      });
      const defaults = resolveAgentHarnessDeliveryDefaults({
        provider: candidate.provider,
        modelId: candidate.model,
        config: params.cfg,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
        agentHarnessId: resolveSessionPinnedHarnessId(params.entry),
        agentHarnessRuntimeOverride,
      });
      return defaults?.visibleReplies ?? defaults?.sourceVisibleReplies;
    };
    const selectedModelCandidate =
      turnModelCandidate ?? storedModelCandidate ?? channelModelCandidate;
    if (selectedModelCandidate) {
      return resolveCandidateDefault(selectedModelCandidate);
    }
    const sourceProvider = normalizeOptionalString(
      sessionDeliveryOrigin(params.entry)?.provider ?? params.ctx.Provider ?? params.ctx.Surface,
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
