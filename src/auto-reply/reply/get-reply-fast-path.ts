import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveResetPreservedSelection } from "../../config/sessions/reset-preserved-selection.js";
import { loadReplySessionInitializationSnapshot } from "../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { DEFAULT_RESET_TRIGGERS, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../../infra/env.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { isFreeAcpSessionKey } from "../../sessions/session-key-utils.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type {
  FinalizedRuntimeMsgContext as MsgContext,
  FinalizedTemplateContext as TemplateContext,
} from "../templating.js";
import { isFormattedGoalContinuationPrompt } from "./commands-goal.js";
import {
  isCompleteReplyConfig,
  markReplyConfigRuntimeMode,
  usesFullReplyRuntime,
} from "./reply-config-runtime-mode.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import type { SessionInitResult } from "./session-init.types.js";
import { resolveSessionResetCommand } from "./session-reset-command.js";

function isSlowReplyTestAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (isVitestRuntimeEnv(env) && env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS === "1") ||
    env.OPENCLAW_STRICT_FAST_REPLY_CONFIG === "0"
  );
}

export function withFullRuntimeReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markReplyConfigRuntimeMode(config, "full");
}

export function resolveGetReplyConfig(params: {
  getRuntimeConfig: () => OpenClawConfig;
  isFastTestEnv: boolean;
  configOverride?: OpenClawConfig;
}): OpenClawConfig {
  const { configOverride } = params;
  if (configOverride == null) {
    return params.getRuntimeConfig();
  }
  if (isCompleteReplyConfig(configOverride)) {
    return configOverride;
  }
  if (params.isFastTestEnv && !isSlowReplyTestAllowed()) {
    throw new Error(
      "Fast reply tests must pass with withFastReplyConfig()/markCompleteReplyConfig(); set OPENCLAW_ALLOW_SLOW_REPLY_TESTS=1 to opt out.",
    );
  }
  return applyMergePatch(params.getRuntimeConfig(), configOverride) as OpenClawConfig;
}

export function shouldUseReplyFastTestRuntime(params: {
  cfg?: OpenClawConfig;
  isFastTestEnv: boolean;
}): boolean {
  return (
    params.isFastTestEnv && isCompleteReplyConfig(params.cfg) && !usesFullReplyRuntime(params.cfg)
  );
}

export async function initFastReplySessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  commandAuthorized: boolean;
  workspaceDir: string;
}): Promise<SessionInitResult> {
  const { ctx, cfg, agentId, commandAuthorized } = params;
  const sessionScope = cfg.session?.scope ?? "per-sender";
  const sessionKey =
    resolveCommandTurnTargetSessionKey(ctx) ||
    resolveSessionKey(sessionScope, ctx, cfg.session?.mainKey, agentId);
  // Free ACP harness sessions persist under the harness key's agent scope; only the
  // published dispatch runtime uses the configured owner (#146365).
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const initAgentId =
    isFreeAcpSessionKey(sessionKey) && sessionKeyAgentId
      ? normalizeAgentId(sessionKeyAgentId)
      : agentId;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: initAgentId });
  const relatedSessionKeys = [
    ctx.ParentSessionKey,
    ctx.ModelParentSessionKey,
    ctx.CommandTargetSessionKey,
    resolveSessionParentSessionKey(sessionKey),
  ].filter((key): key is string => typeof key === "string");
  const snapshot = await loadReplySessionInitializationSnapshot({
    agentId: initAgentId,
    storePath,
    sessionKey,
    relatedSessionKeys,
  });
  const existingEntry = snapshot.currentEntry;
  const sessionStore: Record<string, SessionEntry> = {};
  for (const key of [...relatedSessionKeys, existingEntry?.parentSessionKey]) {
    const entry = key ? snapshot.readEntry(key) : undefined;
    if (key && entry) {
      sessionStore[key] = entry;
    }
  }
  const commandSource = ctx.commandText;
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup = normalizedChatType != null && normalizedChatType !== "direct";
  const resetCommand = resolveSessionResetCommand({
    commandText: commandSource,
    rawText: ctx.rawText,
    resetTriggers: cfg.session?.resetTriggers?.length
      ? cfg.session.resetTriggers
      : DEFAULT_RESET_TRIGGERS,
    ctx,
    cfg,
    agentId,
    isGroup,
    resetAuthorized: commandAuthorized,
  });
  const triggerBodyNormalized = isFormattedGoalContinuationPrompt(commandSource)
    ? commandSource.trim()
    : resetCommand.triggerBodyNormalized;
  const resetTriggered = resetCommand.matchedResetTriggerLower !== undefined;
  if (resetTriggered && isModelSelectionLocked(existingEntry)) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
  }
  const previousSessionEntry = resetTriggered && existingEntry ? { ...existingEntry } : undefined;
  const sessionId =
    !resetTriggered && existingEntry ? existingEntry.sessionId : crypto.randomUUID();
  const bodyStripped = resetTriggered ? (resetCommand.payload ?? "") : ctx.agentText;
  const now = Date.now();
  const resetPreservedSelection = resetTriggered
    ? resolveResetPreservedSelection({ entry: existingEntry })
    : {};
  const channel = normalizeOptionalString(ctx.Provider);
  const subject = normalizeOptionalString(ctx.GroupSubject);
  const groupChannel = normalizeOptionalString(ctx.GroupChannel);
  const sessionEntry: SessionEntry = {
    ...(!resetTriggered ? existingEntry : undefined),
    sessionId,
    ...(!existingEntry && ctx.SessionCreation
      ? buildSessionCreationStamp(ctx.SessionCreation)
      : {}),
    ...(resetTriggered && existingEntry
      ? {
          previousSessionId: existingEntry.sessionId,
          spawnedBy: existingEntry.spawnedBy,
          spawnedBySenderIsOwner: existingEntry.spawnedBySenderIsOwner,
          spawnedBySessionId: existingEntry.spawnedBySessionId,
          spawnedWorkspaceDir: existingEntry.spawnedWorkspaceDir,
          spawnedCwd: existingEntry.spawnedCwd,
          parentSessionKey: existingEntry.parentSessionKey,
          parentSessionId: existingEntry.parentSessionId,
          parentSessionLifecycleRevision: existingEntry.parentSessionLifecycleRevision,
          forkedFromParent: existingEntry.forkedFromParent,
          forkSource: existingEntry.forkSource,
          createdVia: existingEntry.createdVia,
          createdActor: existingEntry.createdActor,
          createdAt: existingEntry.createdAt,
          ...(existingEntry.sandbox === "required" ? { sandbox: "required" as const } : {}),
          spawnDepth: existingEntry.spawnDepth,
          subagentRole: existingEntry.subagentRole,
          subagentControlScope: existingEntry.subagentControlScope,
        }
      : {}),
    ...resetPreservedSelection,
    updatedAt: now,
    sessionStartedAt: resetTriggered ? now : (existingEntry?.sessionStartedAt ?? now),
    lastInteractionAt: now,
    agentStatus: undefined,
    thinkingLevel: existingEntry?.thinkingLevel,
    verboseLevel: existingEntry?.verboseLevel,
    reasoningLevel: existingEntry?.reasoningLevel,
    ttsAuto: existingEntry?.ttsAuto,
    responseUsage: existingEntry?.responseUsage,
    ...(normalizedChatType ? { chatType: normalizedChatType } : {}),
    ...(channel ? { channel } : {}),
    ...(subject ? { subject } : {}),
    ...(groupChannel ? { groupChannel } : {}),
    topicName: normalizeOptionalString(ctx.TopicName) ?? existingEntry?.topicName,
  };
  sessionStore[sessionKey] = sessionEntry;
  const sessionEntryHandle = createReplySessionEntryHandle({
    sessionEntry,
    sessionKey,
    sessionStore,
  });
  const sessionCtx: TemplateContext = {
    ...ctx,
    commandText: ctx.commandText,
    agentText: bodyStripped,
    rawText: ctx.rawText,
    SessionKey: sessionKey,
    CommandAuthorized: commandAuthorized,
    BodyStripped: bodyStripped,
    ...(normalizedChatType ? { ChatType: normalizedChatType } : {}),
  };
  return {
    sessionCtx,
    sessionEntry,
    initialSessionEntry: existingEntry ? { ...existingEntry } : undefined,
    sessionEntryHandle,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession: resetTriggered || !existingEntry,
    resetTriggered,
    systemSent: false,
    abortedLastRun: false,
    storePath,
    sessionScope,
    groupResolution: undefined,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
    previousSessionEntry,
  };
}
