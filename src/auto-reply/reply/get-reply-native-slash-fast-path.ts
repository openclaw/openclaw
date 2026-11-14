import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import {
  resolveModelRefFromString,
  resolveThinkingDefault,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import { readPreparedModelCatalog } from "../../agents/prepared-model-catalog.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { recordSessionCreated } from "../../sessions/session-created.js";
import { resolveStoredModelOverrideAsync } from "../../sessions/stored-model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { isInternalMessageChannel, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import { isAuthorizedTextSlashCommandTurn, isNativeCommandTurn } from "../command-turn-context.js";
import { markCommandReplyForDelivery, type ReplyPayload } from "../reply-payload.js";
import type { FinalizedRuntimeMsgContext as MsgContext } from "../templating.js";
import { normalizeThinkLevel } from "../thinking.js";
import { takeCommandSessionMetadataChangesFromTargets } from "./command-session-metadata.js";
import { buildCommandContext } from "./commands-context.js";
import { resolveSlashCommandName } from "./commands-slash-parse.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { stripStructuralPrefixes } from "./mentions.js";
import { resolveContextTokens } from "./model-selection-context.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";
import { createSkillCommandLoaders } from "./skill-command-loaders.js";
import type { createTypingController } from "./typing.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;

const commandsRuntimeLoader = createLazyImportLoader(() => import("./commands.js"));
const skillCommandsRuntimeLoader = createLazyImportLoader(
  () => import("../../skills/discovery/chat-commands.runtime.js"),
);
const statusCommandRuntimeLoader = createLazyImportLoader(() => import("./commands-status.js"));

function resolveNativeCommandChannelOverride(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  channel: string;
  sessionEntry: SessionEntry;
}) {
  const { cfg, ctx, channel, sessionEntry } = params;
  const deliveryChannel = normalizeMessageChannel(sessionDeliveryChannel(sessionEntry));
  // A shared session's stale peer must not outrank the current native command's sender.
  const deliveryOrigin =
    deliveryChannel && deliveryChannel === normalizeMessageChannel(channel)
      ? sessionDeliveryOrigin(sessionEntry)
      : undefined;
  return resolveChannelModelOverride({
    cfg,
    channel,
    groupId: sessionEntry.groupId,
    groupChatType: sessionEntry.chatType ?? ctx.ChatType,
    groupChannel: sessionEntry.groupChannel ?? ctx.GroupChannel,
    groupSubject: sessionEntry.subject ?? ctx.GroupSubject,
    parentSessionKey:
      ctx.ModelParentSessionKey ?? ctx.ParentSessionKey ?? sessionEntry.parentSessionKey,
    directUserIds: [
      deliveryOrigin?.nativeDirectUserId,
      deliveryOrigin?.from,
      deliveryOrigin?.to,
      ctx.OriginatingTo,
      ctx.From,
      ctx.SenderId,
    ],
  });
}

function shouldRunNativeSlashCommandFastPath(ctx: MsgContext): boolean {
  const commandTurn = ctx.CommandTurn;
  if (!isNativeCommandTurn(commandTurn) && !isAuthorizedTextSlashCommandTurn(commandTurn)) {
    return false;
  }
  const commandName = resolveSlashCommandName(stripStructuralPrefixes(ctx.commandText ?? ""));
  if (
    !commandName ||
    commandName === "new" ||
    commandName === "reset" ||
    // Prompt-producing commands must be consumed once by the full reply pipeline;
    // their resulting text is not another command or directive invocation.
    commandName === "dashboard" ||
    commandName === "followup"
  ) {
    return false;
  }
  return (
    isNativeCommandTurn(commandTurn) ||
    ((commandName === "export-trajectory" || commandName === "trajectory") &&
      ctx.ChatType !== "group" &&
      isInternalMessageChannel(normalizeOptionalString(ctx.Provider)) &&
      (ctx.Surface === undefined ||
        isInternalMessageChannel(normalizeOptionalString(ctx.Surface))) &&
      (ctx.OriginatingChannel === undefined ||
        isInternalMessageChannel(normalizeOptionalString(ctx.OriginatingChannel))))
  );
}

export async function maybeResolveNativeSlashCommandFastReply(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  commandAuthorized: boolean;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  provider: string;
  model: string;
  workspaceDir: string;
  typing: ReturnType<typeof createTypingController>;
  preparedModelCatalog?: ModelCatalogSnapshot;
  opts?: InternalGetReplyOptions;
  skillFilter?: string[];
}): Promise<
  | { handled: true; reply: ReplyPayload | ReplyPayload[] | undefined }
  | { handled: false; queueModeOverride?: QueueMode }
> {
  if (!shouldRunNativeSlashCommandFastPath(params.ctx)) {
    return { handled: false };
  }

  const sessionState = await initFastReplySessionState(params);
  if (params.commandAuthorized) {
    const creatingSession = sessionState.initialSessionEntry === undefined;
    const initializationEntry = sessionState.initialSessionEntry ?? sessionState.sessionEntry;
    const persistence = await persistReplySessionEntry({
      storePath: sessionState.storePath,
      sessionKey: sessionState.sessionKey,
      allowCreate: creatingSession,
      initialEntry: initializationEntry,
      entry: sessionState.sessionEntry,
      skipMaintenance: !creatingSession,
    });
    if (persistence.status === "lifecycle-invalidated") {
      params.typing.cleanup();
      return {
        handled: true,
        reply: markCommandReplyForDelivery({
          text: persistence.error,
        }),
      };
    }
    const persistedInitialEntry = persistence.entry;
    if (creatingSession) {
      await recordSessionCreated(params.cfg, {
        sessionKey: sessionState.sessionKey,
        agentId: params.agentId,
        entry: persistedInitialEntry,
      });
    }
    // Commit the synthesized activity/channel touch before commands or directives
    // capture their own mutation baseline.
    sessionState.sessionEntry = persistedInitialEntry;
    sessionState.sessionEntryHandle.replaceCurrent(persistedInitialEntry);
    sessionState.sessionId = persistedInitialEntry.sessionId;
  }
  const commandContext = {
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: sessionState.sessionKey,
    isGroup: sessionState.isGroup,
    triggerBodyNormalized: sessionState.triggerBodyNormalized,
    commandAuthorized: params.commandAuthorized,
  };
  const command = buildCommandContext(
    commandContext,
    await resolveCommandAuthorizationAsync(commandContext),
  );
  const commandScope = () => ({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: sessionState.sessionKey,
    sessionScope: sessionState.sessionScope,
    storePath: sessionState.storePath,
    workspaceDir: params.workspaceDir,
    isGroup: sessionState.isGroup,
  });
  if (command.commandBodyNormalized === "/status") {
    const targetSessionEntry =
      sessionState.sessionStore[sessionState.sessionKey] ?? sessionState.sessionEntry;
    const canApplyStoredModel =
      params.provider === params.defaultProvider && params.model === params.defaultModel;
    const storedModelOverride = canApplyStoredModel
      ? await resolveStoredModelOverrideAsync({
          sessionEntry: targetSessionEntry,
          sessionStore: sessionState.sessionStore,
          sessionKey: sessionState.sessionKey,
          parentSessionKey:
            targetSessionEntry?.parentSessionKey ??
            params.ctx.ModelParentSessionKey ??
            params.ctx.ParentSessionKey,
          defaultProvider: params.defaultProvider,
        })
      : null;
    const canApplyChannelModel =
      params.cfg.channels?.modelByChannel &&
      !isModelSelectionLocked(targetSessionEntry) &&
      !storedModelOverride &&
      !normalizeOptionalString(targetSessionEntry?.modelOverride) &&
      !normalizeOptionalString(targetSessionEntry?.providerOverride) &&
      canApplyStoredModel;
    const channelModelOverride = canApplyChannelModel
      ? resolveNativeCommandChannelOverride({
          cfg: params.cfg,
          ctx: params.ctx,
          channel: command.channel,
          sessionEntry: targetSessionEntry,
        })
      : null;
    const resolvedChannelModel = channelModelOverride
      ? resolveModelRefFromString({
          raw: channelModelOverride.model,
          defaultProvider: params.defaultProvider,
          aliasIndex: params.aliasIndex,
        })
      : null;
    const resolvedInheritedModel =
      storedModelOverride?.source === "parent"
        ? (resolveModelRefFromString({
            raw: `${storedModelOverride.provider ?? params.defaultProvider}/${storedModelOverride.model}`,
            defaultProvider: params.defaultProvider,
            aliasIndex: params.aliasIndex,
          })?.ref ?? {
            provider: storedModelOverride.provider ?? params.defaultProvider,
            model: storedModelOverride.model,
          })
        : null;
    // Parent/channel preferences replace the base route. Direct session pins stay
    // with status's selected/active-model owner, which also supplies thinking defaults.
    const statusProvider =
      resolvedInheritedModel?.provider ?? resolvedChannelModel?.ref.provider ?? params.provider;
    const statusModel =
      resolvedInheritedModel?.model ?? resolvedChannelModel?.ref.model ?? params.model;
    const resolvedThinkLevel = normalizeThinkLevel(targetSessionEntry?.thinkingLevel);
    // This fast path has no model-state owner; prepare side-effect-free catalog facts directly.
    const thinkingCatalog = await readPreparedModelCatalog({
      config: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      readOnly: true,
    });
    const { buildStatusReply } = await statusCommandRuntimeLoader.load();
    return {
      handled: true,
      reply: markCommandReplyForDelivery(
        await buildStatusReply({
          ...commandScope(),
          command,
          sessionEntry: targetSessionEntry,
          parentSessionKey: targetSessionEntry?.parentSessionKey ?? params.ctx.ParentSessionKey,
          provider: statusProvider,
          model: statusModel,
          thinkingCatalog,
          resolvedThinkLevel,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolvedElevatedLevel: "off",
          resolveDefaultThinkingLevel: async (selection) =>
            resolveThinkingDefault({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: statusProvider,
              model: statusModel,
              ...selection,
              catalog: thinkingCatalog,
            }),
          defaultGroupActivation: () => "always",
          mediaDecisions: params.ctx.MediaUnderstandingDecisions,
        }),
      ),
    };
  }

  let loadedSkillCommands: SkillCommandSpec[] | undefined;
  const loadNativeSkillCommands = async () => {
    loadedSkillCommands ??= await (
      await skillCommandsRuntimeLoader.load()
    ).prepareSkillCommandsForWorkspace({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      sessionEntry: sessionState.sessionEntry,
      sessionKey: sessionState.sessionKey,
    });
    return loadedSkillCommands;
  };

  // These commands need the selected model's transcript, context budget, or tool inventory.
  const needsToolsModelSelection =
    command.isAuthorizedSender &&
    (command.commandBodyNormalized === "/tools" ||
      command.commandBodyNormalized === "/tools compact" ||
      command.commandBodyNormalized === "/tools verbose");
  const needsModelSelection =
    needsToolsModelSelection ||
    (command.isAuthorizedSender &&
      (command.commandBodyNormalized === "/compact" ||
        command.commandBodyNormalized.startsWith("/compact ") ||
        command.commandBodyNormalized.startsWith("/context ")));
  const commandResult = needsModelSelection
    ? { shouldContinue: true, reply: undefined }
    : await (
        await commandsRuntimeLoader.load()
      ).handleCommands({
        ...commandScope(),
        ctx: sessionState.sessionCtx,
        rootCtx: params.ctx,
        command,
        agentDir: params.agentDir,
        directives: clearInlineDirectives(sessionState.triggerBodyNormalized),
        elevated: {
          enabled: false,
          allowed: false,
          failures: [],
        },
        sessionEntry: sessionState.sessionEntry,
        previousSessionEntry: sessionState.previousSessionEntry,
        sessionStore: sessionState.sessionStore,
        opts: params.opts,
        defaultGroupActivation: () => "always",
        resolveModelLevels: async () => ({
          resolvedThinkLevel: undefined,
          resolvedReasoningLevel: "off",
          thinkingExplicit: false,
        }),
        resolvedVerboseLevel: "off",
        resolvedElevatedLevel: "off",
        blockReplyChunking: undefined,
        resolvedBlockStreamingBreak: "text_end",
        resolveDefaultThinkingLevel: async () => undefined,
        provider: params.provider,
        model: params.model,
        contextTokens: resolveContextTokens({
          cfg: params.cfg,
          provider: params.provider,
          model: params.model,
        }),
        ...createSkillCommandLoaders(skillCommandsRuntimeLoader.load, {
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          agentId: params.agentId,
          skillFilter: params.skillFilter,
          sessionEntry: sessionState.sessionEntry,
          sessionKey: sessionState.sessionKey,
          loadSkillCommands: loadNativeSkillCommands,
        }),
        typing: params.typing,
      });
  const commandSessionMetadataChanges = takeCommandSessionMetadataChangesFromTargets([
    sessionState.sessionCtx,
    params.ctx,
  ]);
  if (commandSessionMetadataChanges) {
    params.opts?.onSessionMetadataChanges?.(commandSessionMetadataChanges);
  }
  if (!commandResult.shouldContinue) {
    params.typing.cleanup();
    return { handled: true, reply: markCommandReplyForDelivery(commandResult.reply) };
  }
  const continuationTriggerBodyNormalized = command.rawBodyNormalized;
  const targetSessionEntry =
    sessionState.sessionStore[sessionState.sessionKey] ?? sessionState.sessionEntry;
  const sessionModelSelectionLocked = isModelSelectionLocked(targetSessionEntry);
  const hasResolvedTurnModelOverride =
    !sessionModelSelectionLocked && Boolean(normalizeOptionalString(params.opts?.modelOverride));
  let selectedChannelModel: ReturnType<typeof resolveModelRefFromString> = null;
  if (
    needsToolsModelSelection &&
    params.cfg.channels?.modelByChannel &&
    !hasResolvedTurnModelOverride &&
    !sessionModelSelectionLocked
  ) {
    const channelModelOverride = resolveNativeCommandChannelOverride({
      cfg: params.cfg,
      ctx: params.ctx,
      channel: command.channel,
      sessionEntry: targetSessionEntry,
    });
    selectedChannelModel = channelModelOverride
      ? resolveModelRefFromString({
          cfg: params.cfg,
          agentId: params.agentId,
          raw: channelModelOverride.model,
          defaultProvider: params.defaultProvider,
          aliasIndex: params.aliasIndex,
        })
      : null;
  }

  const directiveResult = await resolveReplyDirectives({
    ...params,
    ...sessionState,
    conversation: prepareReplyConversation({
      ctx: sessionState.sessionCtx,
      sessionEntry: sessionState.sessionStore[sessionState.sessionKey] ?? sessionState.sessionEntry,
      groupResolution: sessionState.groupResolution,
    }),
    triggerBodyNormalized: continuationTriggerBodyNormalized,
    resetTriggered: false,
    ...(needsToolsModelSelection
      ? {
          provider:
            selectedChannelModel?.ref.provider ??
            (sessionModelSelectionLocked ? params.defaultProvider : params.provider),
          model:
            selectedChannelModel?.ref.model ??
            (sessionModelSelectionLocked ? params.defaultModel : params.model),
          primaryProvider: selectedChannelModel?.ref.provider ?? params.defaultProvider,
          primaryModel: selectedChannelModel?.ref.model ?? params.defaultModel,
          hasResolvedTurnModelOverride,
        }
      : {}),
  });
  if (directiveResult.kind === "reply") {
    // The canonical directive owner already finalizes typing for every terminal reply.
    return { handled: true, reply: markCommandReplyForDelivery(directiveResult.reply) };
  }

  const shouldPrepareStatusThinkingCatalog =
    directiveResult.result.inlineStatusRequested ||
    directiveResult.result.directives.hasStatusDirective ||
    directiveResult.result.command.commandBodyNormalized.trim() === "/status";
  const thinkingCatalog = shouldPrepareStatusThinkingCatalog
    ? await directiveResult.result.modelState.resolveThinkingCatalog()
    : undefined;

  const inlineActionResult = await handleInlineActions({
    ...directiveResult.result,
    ...commandScope(),
    ctx: params.ctx,
    sessionCtx: sessionState.sessionCtx,
    agentDir: params.agentDir,
    sessionEntry: sessionState.sessionEntry,
    ...(sessionState.initialSessionEntry
      ? { initialSessionEntry: sessionState.initialSessionEntry }
      : {}),
    allowCreateSessionEntry: sessionState.initialSessionEntry === undefined,
    previousSessionEntry: sessionState.previousSessionEntry,
    sessionStore: sessionState.sessionStore,
    opts: params.opts,
    typing: params.typing,
    skillCommands: loadedSkillCommands ?? directiveResult.result.skillCommands,
    defaultActivation: () => directiveResult.result.defaultActivation,
    thinkingCatalog,
    resolveDefaultThinkingLevel: directiveResult.result.modelState.resolveDefaultThinkingLevel,
    abortedLastRun: sessionState.abortedLastRun,
    skillFilter: params.skillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    return {
      handled: true,
      reply: markCommandReplyForDelivery(inlineActionResult.reply),
    };
  }
  const queueModeOverride = inlineActionResult.queueModeOverride ?? commandResult.queueModeOverride;
  return { handled: false, ...(queueModeOverride ? { queueModeOverride } : {}) };
}
