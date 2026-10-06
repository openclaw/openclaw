import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeNullableString,
} from "@openclaw/normalization-core/string-coerce";
import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import type { ExecPolicyOverrides } from "../../agents/exec-defaults.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  expandBundleCommandPromptTemplate,
  expandExplicitSkillReferences,
  hasSkillReferenceCandidate,
  listReservedChatSlashCommandNames,
  mergeExplicitSkillSelections as mergeSelections,
  resolveSkillCommandInvocation,
  skillCommandsToExplicitSelections as toSelections,
} from "../../skills/discovery/chat-command-invocation.js";
import type { ExplicitSkillSelection } from "../../skills/types.js";
import {
  copyReplyPayloadMetadata,
  markCommandReplyForDelivery,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { ElevatedLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  readAbortCutoffFromSessionEntry,
  resolveAbortCutoffFromContext,
  shouldSkipMessageByAbortCutoff,
} from "./abort-cutoff.js";
import { getAbortMemory, isAbortRequestText } from "./abort-primitives.js";
import { takeCommandSessionMetadataChangesFromTargets } from "./command-session-metadata.js";
import type { CommandDispatchParams } from "./commands-types.js";
import type { buildStatusReply } from "./commands.runtime.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { extractExplicitGroupId } from "./group-id.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { getStandaloneSlashCommandName } from "./reply-inline.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { createSkillCommandLoaders } from "./skill-command-loaders.js";
import type { TypingController } from "./typing.js";

const skillCommandsRuntimeLoader = createLazyImportLoader(
  () => import("../../skills/discovery/chat-commands.runtime.js"),
);
const skillToolDispatchRuntimeLoader = createLazyImportLoader(
  () => import("../../skills/runtime/tool-dispatch.js"),
);
const abortCutoffRuntimeLoader = createLazyImportLoader(() => import("./abort-cutoff.runtime.js"));
const commandsRuntimeLoader = createLazyImportLoader(() => import("./commands.runtime.js"));
let builtinSlashCommands: Set<string> | null = null;

function getBuiltinSlashCommands(): Set<string> {
  if (builtinSlashCommands) {
    return builtinSlashCommands;
  }
  builtinSlashCommands = listReservedChatSlashCommandNames([
    "btw",
    "think",
    "verbose",
    "reasoning",
    "elevated",
    "exec",
    "model",
    "status",
    "queue",
  ]);
  return builtinSlashCommands;
}

function resolveSlashCommandName(commandBodyNormalized: string): string | null {
  const match = commandBodyNormalized.trim().match(/^\/([^\s:]+)(?::|\s|$)/);
  return normalizeOptionalLowercaseString(match?.[1]) ?? null;
}

function isMentionOnlyResidualText(text: string, wasMentioned: boolean | undefined): boolean {
  if (wasMentioned !== true) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return /^(?:<@[!&]?[A-Za-z0-9._:-]+>|<!(?:here|channel|everyone)>|[:,.!?-]|\s)+$/u.test(trimmed);
}

type InlineActionResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      abortedLastRun: boolean;
      cleanedBody: string;
      queueModeOverride?: QueueMode;
      explicitSkillSelections?: ExplicitSkillSelection[];
    };

export async function handleInlineActions(
  params: Omit<
    CommandDispatchParams,
    | "rootCtx"
    | "elevated"
    | "defaultGroupActivation"
    | "resolvedThinkLevel"
    | "resolvedFastMode"
    | "loadSkillCommands"
    | "loadBundledSkillCommand"
    | "commandInvocationSignal"
    | "compactionSessionEntry"
    | "typing"
    | "sessionScope"
    | "resolvedVerboseLevel"
    | "resolvedElevatedLevel"
  > & {
    sessionCtx: TemplateContext;
    sessionScope: Parameters<typeof buildStatusReply>[0]["sessionScope"];
    typing: TypingController;
    allowTextCommands: boolean;
    inlineStatusRequested: boolean;
    inlineCommand?: string;
    cleanedBody: string;
    elevatedEnabled: boolean;
    elevatedAllowed: boolean;
    elevatedFailures: CommandDispatchParams["elevated"]["failures"];
    defaultActivation: CommandDispatchParams["defaultGroupActivation"];
    resolvedVerboseLevel: VerboseLevel | undefined;
    resolvedElevatedLevel: ElevatedLevel;
    execOverrides?: ExecPolicyOverrides;
    directiveAck?: ReplyPayload;
    abortedLastRun: boolean;
    skillFilter?: string[];
  },
): Promise<InlineActionResult> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    initialSessionEntry,
    allowCreateSessionEntry,
    previousSessionEntry,
    previousSessionMemory,
    previousSessionResetMessages,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    directives: initialDirectives,
    cleanedBody: initialCleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    thinkingCatalog,
    resolveModelLevels,
    resolvedVerboseLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun: initialAbortedLastRun,
    skillFilter,
  } = params;
  const finishCommand = (reply?: ReplyPayload | ReplyPayload[]): InlineActionResult => {
    typing.cleanup();
    return { kind: "reply", reply: markCommandReplyForDelivery(reply) };
  };
  const notifyInlineCommandSessionMetadataChanges = () => {
    const changes = takeCommandSessionMetadataChangesFromTargets([sessionCtx, ctx]);
    if (changes) {
      opts?.onSessionMetadataChanges?.(changes);
    }
  };

  let directives = initialDirectives;
  let cleanedBody = initialCleanedBody;
  const updateAgentBody = (body: string) => {
    ctx.Body = body;
    ctx.agentText = body;
    ctx.BodyForAgent = body;
    sessionCtx.Body = body;
    sessionCtx.agentText = body;
    sessionCtx.BodyForAgent = body;
    sessionCtx.BodyStripped = body;
    cleanedBody = body;
  };
  let skillSelections: ExplicitSkillSelection[] | undefined;
  const targetSessionEntry = sessionStore?.[sessionKey] ?? sessionEntry;

  if (targetSessionEntry && !isAbortRequestText(command.rawBodyNormalized)) {
    const cutoff = readAbortCutoffFromSessionEntry(targetSessionEntry);
    const incoming = resolveAbortCutoffFromContext(ctx);
    if (
      cutoff &&
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: cutoff.messageSid,
        cutoffTimestamp: cutoff.timestamp,
        messageSid: incoming?.messageSid,
        timestamp: incoming?.timestamp,
      })
    ) {
      const runState = resolveReplyOperationRunState(opts);
      if (runState) {
        // The stop owner cancelled this queued input; no answer remains due.
        runState.replyCompletion = resolveReplyCompletion(
          runState.replyCompletion?.expectation ?? "required",
          "blocked",
        );
      }
      return finishCommand();
    }
    if (cutoff) {
      await (
        await abortCutoffRuntimeLoader.load()
      ).clearAbortCutoffInSessionRuntime({
        sessionEntry: targetSessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  const skipWhenConfigEmpty = command.channelId
    ? Boolean(getChannelPlugin(command.channelId)?.commands?.skipWhenConfigEmpty)
    : false;
  if (
    skipWhenConfigEmpty &&
    Object.keys(cfg).length === 0 &&
    command.from &&
    command.to &&
    command.from !== command.to
  ) {
    return finishCommand();
  }

  const slashCommandName = getStandaloneSlashCommandName(command.commandBodyNormalized);
  const explicitSkillReferenceBody = command.commandBodyNormalized;
  const hasSkillReferences =
    command.isAuthorizedSender && hasSkillReferenceCandidate(explicitSkillReferenceBody);
  const hasSkillSlashCandidate =
    command.isAuthorizedSender &&
    slashCommandName !== null &&
    (slashCommandName === "skill" || !getBuiltinSlashCommands().has(slashCommandName));
  const shouldLoadSkillCommands =
    allowTextCommands && (hasSkillReferences || hasSkillSlashCandidate);
  const skillCommandContext = {
    workspaceDir,
    cfg,
    agentId,
    sessionEntry: targetSessionEntry,
    sessionKey,
    execOverrides,
  };
  const skillCommands =
    shouldLoadSkillCommands &&
    execOverrides === undefined &&
    params.skillCommands &&
    params.skillCommands.length > 0
      ? params.skillCommands
      : shouldLoadSkillCommands
        ? await (
            await skillCommandsRuntimeLoader.load()
          ).prepareSkillCommandsForWorkspace({
            ...skillCommandContext,
            skillFilter,
          })
        : [];
  const allSkillCommands =
    shouldLoadSkillCommands && skillFilter !== undefined
      ? await (
          await skillCommandsRuntimeLoader.load()
        ).prepareSkillCommandsForWorkspace({
          ...skillCommandContext,
          includeAllowlistHidden: true,
        })
      : skillCommands;

  const skillInvocation =
    skillCommands.length > 0
      ? resolveSkillCommandInvocation({
          commandBodyNormalized: command.commandBodyNormalized,
          skillCommands,
        })
      : null;
  if (skillInvocation) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /${skillInvocation.command.name} from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      return finishCommand();
    }

    const dispatch = skillInvocation.command.dispatch;
    if (dispatch?.kind === "tool") {
      const rawArgs = (skillInvocation.args ?? "").trim();
      const { resolveSkillDispatchTools } = await skillToolDispatchRuntimeLoader.load();
      const dependencies = await import("../../agents/openclaw-tools.js");
      const { hasAnyAuthProfileStoreSourceAsync } =
        await import("../../agents/auth-profiles/source-check.js");
      const authSourceAgentDir = agentDir?.trim();
      const authProfileStoreSource = authSourceAgentDir
        ? await hasAnyAuthProfileStoreSourceAsync(authSourceAgentDir)
        : false;
      const authorizedTools = await resolveSkillDispatchTools(
        {
          message: {
            surface: ctx.Surface,
            provider: ctx.Provider,
            accountId: ctx.AccountId,
            senderId: ctx.SenderId,
            senderName: ctx.SenderName,
            senderUsername: ctx.SenderUsername,
            senderE164: ctx.SenderE164,
            originatingTo: ctx.OriginatingTo,
            to: ctx.To,
            nativeChannelId: ctx.NativeChannelId,
            messageThreadId: ctx.MessageThreadId,
            memberRoleIds: ctx.MemberRoleIds,
          },
          cfg,
          agentId,
          agentDir,
          authProfileStoreSource,
          sessionEntry: targetSessionEntry,
          sessionKey,
          workspaceDir,
          provider,
          model,
          senderIsOwner: command.senderIsOwner,
          senderId: command.senderId,
          currentChannelId: command.channelId,
          groupId: extractExplicitGroupId(ctx.From),
          skillCommand: {
            name: skillInvocation.command.name,
            ...(skillInvocation.command.skillFile
              ? { skillFile: skillInvocation.command.skillFile }
              : {}),
            skillName: skillInvocation.command.skillName,
            ...(skillInvocation.command.skillSource
              ? { skillSource: skillInvocation.command.skillSource }
              : {}),
            toolName: dispatch.toolName,
          },
        },
        dependencies,
      );

      const tool = authorizedTools.find((candidate) => candidate.name === dispatch.toolName);
      if (!tool) {
        return finishCommand({ text: `❌ Tool not available: ${dispatch.toolName}` });
      }

      const toolCallId = `cmd_${generateSecureToken(8)}`;
      try {
        const toolArgs: Parameters<NonNullable<typeof tool.execute>>[1] = {
          command: rawArgs,
          commandName: skillInvocation.command.name,
          skillName: skillInvocation.command.skillName,
        };
        opts?.abortSignal?.throwIfAborted();
        if (opts?.runId) {
          const transcriptStart =
            opts.onAgentRunStart && params.sessionEntry?.sessionId
              ? await (
                  await import("../../config/sessions/session-transcript-watermark.js")
                ).readSessionTranscriptStartAsync({
                  agentId: params.agentId,
                  sessionId: params.sessionEntry.sessionId,
                  sessionKey: params.sessionKey,
                  storePath:
                    params.storePath ??
                    resolveSessionStorePathCore(params.cfg.session?.store, {
                      agentId: params.agentId,
                    }),
                })
              : null;
          opts.abortSignal?.throwIfAborted();
          // Tool commands leave transcript persistence with ordinary reply dispatch.
          opts.onAgentRunStart?.(
            opts.runId,
            undefined,
            {
              completionSource: "reply-dispatch",
              getResult: () => ({}),
            },
            transcriptStart,
          );
        }
        // The execution owner can observe revocation while arming cancellation.
        opts?.abortSignal?.throwIfAborted();
        const result = asOptionalObjectRecord(
          await tool.execute(toolCallId, toolArgs, opts?.abortSignal),
        );
        const details = asOptionalObjectRecord(result?.details);
        const blockedReason =
          details?.status === "blocked" ? normalizeNullableString(details.reason) : null;
        if (blockedReason) {
          return finishCommand({ text: `❌ Tool call blocked: ${blockedReason}` });
        }
        const content = result?.content;
        const text =
          normalizeNullableString(
            typeof content === "string" ? content : collectTextContentBlocks(content).join(""),
          ) ?? "✅ Done.";
        return finishCommand({ text });
      } catch (err) {
        const message = formatErrorMessage(err);
        return finishCommand({ text: `❌ ${message}` });
      }
    }

    if (skillInvocation.command.promptTemplate) {
      const rewrittenBody = expandBundleCommandPromptTemplate(
        skillInvocation.command.promptTemplate,
        skillInvocation.args,
      );
      updateAgentBody(rewrittenBody);
    }
  }

  const referenced =
    allowTextCommands &&
    (hasSkillReferences || hasSkillSlashCandidate) &&
    !skillInvocation?.command.promptTemplate &&
    (hasSkillSlashCandidate || resolveSlashCommandName(cleanedBody) === null)
      ? expandExplicitSkillReferences({
          text: explicitSkillReferenceBody,
          skillCommands,
          allSkillCommands,
        })
      : null;
  const hasExplicitSkillReferences = Boolean(referenced?.skills.length);

  const sendInlineReply = async (reply?: ReplyPayload) => {
    if (!reply || !opts?.onBlockReply) {
      return;
    }
    await opts.onBlockReply(
      markReplyPayloadForSourceSuppressionDelivery(
        copyReplyPayloadMetadata(reply, {
          ...reply,
          isStatusNotice: true,
        }),
      ),
    );
  };

  // Standalone commands use ordinary dispatch even when the prompt contains extra context.
  const inlineCommand =
    allowTextCommands &&
    command.isAuthorizedSender &&
    !skillInvocation &&
    !hasExplicitSkillReferences &&
    params.inlineCommand !== command.commandBodyNormalized
      ? params.inlineCommand
      : undefined;

  if (referenced) {
    if (referenced.error) {
      return finishCommand({ text: referenced.error });
    }
    if (referenced.skills.length > 0) {
      skillSelections = mergeSelections(skillSelections, toSelections(referenced.skills));
      updateAgentBody(referenced.body);
    }
  }

  const handleInlineStatus =
    !hasExplicitSkillReferences &&
    !isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    }) &&
    inlineStatusRequested;
  let didSendInlineStatus = false;
  let queueModeOverride: QueueMode | undefined;
  if (handleInlineStatus) {
    const { buildStatusReply } = await commandsRuntimeLoader.load();
    const inlineStatusReply = await buildStatusReply({
      cfg,
      agentId,
      command,
      sessionEntry: targetSessionEntry,
      sessionKey,
      parentSessionKey: targetSessionEntry?.parentSessionKey ?? ctx.ParentSessionKey,
      sessionScope,
      storePath,
      provider,
      model,
      contextTokens,
      workspaceDir,
      thinkingCatalog,
      ...(await resolveModelLevels()),
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      isGroup,
      defaultGroupActivation: defaultActivation,
      mediaDecisions: ctx.MediaUnderstandingDecisions,
    });
    await sendInlineReply(inlineStatusReply);
    didSendInlineStatus = true;
    directives = { ...directives, hasStatusDirective: false };
  }

  const runCommands = async (commandInput: typeof command) => {
    const { handleCommands } = await commandsRuntimeLoader.load();
    return handleCommands({
      // Pass sessionCtx so command handlers can mutate stripped body for same-turn continuation.
      ctx: sessionCtx,
      // Keep original finalized context in sync when command handlers need outer-dispatch side effects.
      rootCtx: ctx,
      cfg,
      command: commandInput,
      agentId,
      agentDir,
      directives,
      elevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        failures: elevatedFailures,
      },
      sessionEntry: targetSessionEntry,
      initialSessionEntry,
      allowCreateSessionEntry,
      previousSessionEntry,
      previousSessionMemory,
      previousSessionResetMessages,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      opts,
      defaultGroupActivation: defaultActivation,
      thinkingCatalog,
      resolveModelLevels,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedElevatedLevel,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      isGroup,
      skillCommands,
      ...createSkillCommandLoaders(skillCommandsRuntimeLoader.load, {
        ...skillCommandContext,
        skillFilter,
      }),
      typing,
    });
  };

  if (inlineCommand) {
    const inlineCommandContext = {
      ...command,
      rawBodyNormalized: inlineCommand,
      commandBodyNormalized: inlineCommand,
    };
    const inlineResult = await runCommands(inlineCommandContext);
    queueModeOverride = inlineResult.queueModeOverride;
    skillSelections = mergeSelections(skillSelections, inlineResult.explicitSkillSelections);
    notifyInlineCommandSessionMetadataChanges();
    if (inlineResult.reply) {
      if (!cleanedBody) {
        return finishCommand(inlineResult.reply);
      }
      await sendInlineReply(inlineResult.reply);
    }
  }

  if (directiveAck && !hasExplicitSkillReferences) {
    await sendInlineReply(directiveAck);
  }

  let abortedLastRun = initialAbortedLastRun;
  if (!sessionEntry && command.abortKey) {
    abortedLastRun = getAbortMemory(command.abortKey) ?? false;
  }

  const shouldRunCommandHandlers =
    !hasExplicitSkillReferences &&
    (inlineCommand !== undefined ||
      directiveAck !== undefined ||
      inlineStatusRequested ||
      command.commandBodyNormalized.trim().startsWith("/"));
  if (!shouldRunCommandHandlers) {
    return {
      kind: "continue",
      directives,
      abortedLastRun,
      cleanedBody,
      ...(skillSelections ? { explicitSkillSelections: skillSelections } : {}),
    };
  }
  const strippedBody = stripStructuralPrefixes(cleanedBody);
  const remainingBodyAfterInlineStatus = (
    isGroup ? stripMentions(strippedBody, ctx, cfg, agentId) : strippedBody
  ).trim();
  if (
    didSendInlineStatus &&
    (remainingBodyAfterInlineStatus.length === 0 ||
      isMentionOnlyResidualText(remainingBodyAfterInlineStatus, ctx.WasMentioned))
  ) {
    return finishCommand();
  }

  const commandBodyBeforeRun = command.commandBodyNormalized;
  const bodyBeforeRun = sessionCtx.agentText;
  const commandResult = await runCommands(command);
  queueModeOverride = commandResult.queueModeOverride ?? queueModeOverride;
  skillSelections = mergeSelections(skillSelections, commandResult.explicitSkillSelections);
  notifyInlineCommandSessionMetadataChanges();
  if (!commandResult.shouldContinue) {
    return finishCommand(commandResult.reply);
  }
  if (command.commandBodyNormalized !== commandBodyBeforeRun) {
    cleanedBody = command.commandBodyNormalized;
  } else {
    const bodyAfterRun = sessionCtx.agentText;
    if (bodyAfterRun !== undefined && bodyAfterRun !== bodyBeforeRun) {
      cleanedBody = bodyAfterRun;
    }
  }

  return {
    kind: "continue",
    directives,
    abortedLastRun,
    cleanedBody,
    ...(queueModeOverride ? { queueModeOverride } : {}),
    ...(skillSelections ? { explicitSkillSelections: skillSelections } : {}),
  };
}
