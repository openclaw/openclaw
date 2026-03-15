import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.js";
import type { BlockReplyChunking } from "../../agents/pi-embedded-block-chunker.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../../agents/pi-tools.policy.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../../agents/tool-policy-pipeline.js";
import { resolveToolProfilePolicy } from "../../agents/tool-policy-shared.js";
import { applyOwnerOnlyToolPolicy, mergeAlsoAllowPolicy } from "../../agents/tool-policy.js";
import { getChannelDock } from "../../channels/dock.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import {
  listReservedChatSlashCommandNames,
  listSkillCommandsForWorkspace,
  resolveSkillCommandInvocation,
} from "../skill-commands.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  clearAbortCutoffInSession,
  readAbortCutoffFromSessionEntry,
  resolveAbortCutoffFromContext,
  shouldSkipMessageByAbortCutoff,
} from "./abort-cutoff.js";
import { getAbortMemory, isAbortRequestText } from "./abort.js";
import { buildStatusReply, handleCommands } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import { isDirectiveOnly } from "./directive-handling.js";
import type { createModelSelectionState } from "./model-selection.js";
import { extractInlineSimpleCommand } from "./reply-inline.js";
import type { TypingController } from "./typing.js";

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
  const trimmed = commandBodyNormalized.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = trimmed.match(/^\/([^\s:]+)(?::|\s|$)/);
  const name = match?.[1]?.trim().toLowerCase() ?? "";
  return name ? name : null;
}

export type InlineActionResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      abortedLastRun: boolean;
    };

// oxlint-disable-next-line typescript/no-explicit-any
function extractTextFromToolResult(result: any): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }
  const parts = collectTextContentBlocks(content);
  const out = parts.join("");
  const trimmed = out.trim();
  return trimmed ? trimmed : null;
}

function resolveSkillDispatchTools(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  agentDir?: string;
  provider: string;
  senderIsOwner: boolean;
  senderId?: string;
}) {
  const channel =
    resolveGatewayMessageChannel(params.ctx.Surface) ??
    resolveGatewayMessageChannel(params.ctx.Provider) ??
    undefined;
  const tools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: channel,
    agentAccountId: (params.ctx as { AccountId?: string }).AccountId,
    agentTo: params.ctx.OriginatingTo ?? params.ctx.To,
    agentThreadId: params.ctx.MessageThreadId ?? undefined,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    requesterSenderId: params.senderId ?? undefined,
    senderIsOwner: params.senderIsOwner,
  });
  const toolsByAuthorization = applyOwnerOnlyToolPolicy(tools, params.senderIsOwner);
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.provider,
  });
  const groupCtx = params.ctx as {
    AccountId?: string;
    GroupID?: string;
    GroupChannel?: string;
    GroupSpace?: string;
    SenderId?: string;
    SenderName?: string;
    SenderUsername?: string;
    SenderE164?: string;
  };
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: channel,
    groupId: groupCtx.GroupID,
    groupChannel: groupCtx.GroupChannel,
    groupSpace: groupCtx.GroupSpace,
    accountId: groupCtx.AccountId,
    senderId: groupCtx.SenderId,
    senderName: groupCtx.SenderName,
    senderUsername: groupCtx.SenderUsername,
    senderE164: groupCtx.SenderE164,
  });
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(providerProfile),
    providerProfileAlsoAllow,
  );
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const subagentPolicy = isSubagentSessionKey(params.sessionKey)
    ? resolveSubagentToolPolicyForSession(params.cfg, params.sessionKey)
    : undefined;

  return applyToolPolicyPipeline({
    tools: toolsByAuthorization,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: logVerbose,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy,
        profile,
        providerProfilePolicy,
        providerProfile,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId,
      }),
      { policy: sandboxPolicy, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
    ],
  });
}

export async function handleInlineActions(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: Parameters<typeof buildStatusReply>[0]["sessionScope"];
  workspaceDir: string;
  isGroup: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  allowTextCommands: boolean;
  inlineStatusRequested: boolean;
  command: Parameters<typeof handleCommands>[0]["command"];
  skillCommands?: SkillCommandSpec[];
  directives: InlineDirectives;
  cleanedBody: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultActivation: Parameters<typeof buildStatusReply>[0]["defaultGroupActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  resolveDefaultThinkingLevel: Awaited<
    ReturnType<typeof createModelSelectionState>
  >["resolveDefaultThinkingLevel"];
  provider: string;
  model: string;
  contextTokens: number;
  directiveAck?: ReplyPayload;
  abortedLastRun: boolean;
  skillFilter?: string[];
}): Promise<InlineActionResult> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
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
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
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

  let directives = initialDirectives;
  let cleanedBody = initialCleanedBody;

  const slashCommandName = resolveSlashCommandName(command.commandBodyNormalized);
  const shouldLoadSkillCommands =
    allowTextCommands &&
    slashCommandName !== null &&
    // `/skill …` needs the full skill command list.
    (slashCommandName === "skill" || !getBuiltinSlashCommands().has(slashCommandName));
  const skillCommands =
    shouldLoadSkillCommands && params.skillCommands
      ? params.skillCommands
      : shouldLoadSkillCommands
        ? listSkillCommandsForWorkspace({
            workspaceDir,
            cfg,
            skillFilter,
          })
        : [];

  const skillInvocation =
    allowTextCommands && skillCommands.length > 0
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
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }

    const dispatch = skillInvocation.command.dispatch;
    if (dispatch?.kind === "tool") {
      const rawArgs = (skillInvocation.args ?? "").trim();
      const authorizedTools = resolveSkillDispatchTools({
        ctx,
        cfg,
        agentId,
        sessionKey,
        workspaceDir,
        agentDir,
        provider,
        senderIsOwner: command.senderIsOwner,
        senderId: command.senderId,
      });

      const tool = authorizedTools.find((candidate) => candidate.name === dispatch.toolName);
      if (!tool) {
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ Tool not available: ${dispatch.toolName}` } };
      }

      const toolCallId = `cmd_${generateSecureToken(8)}`;
      try {
        const result = await tool.execute(toolCallId, {
          command: rawArgs,
          commandName: skillInvocation.command.name,
          skillName: skillInvocation.command.skillName,
          // oxlint-disable-next-line typescript/no-explicit-any
        } as any);
        const text = extractTextFromToolResult(result) ?? "✅ Done.";
        typing.cleanup();
        return { kind: "reply", reply: { text } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ ${message}` } };
      }
    }

    const promptParts = [
      `Use the "${skillInvocation.command.skillName}" skill for this request.`,
      skillInvocation.args ? `User input:\n${skillInvocation.args}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    const rewrittenBody = promptParts.join("\n\n");
    ctx.Body = rewrittenBody;
    ctx.BodyForAgent = rewrittenBody;
    sessionCtx.Body = rewrittenBody;
    sessionCtx.BodyForAgent = rewrittenBody;
    sessionCtx.BodyStripped = rewrittenBody;
    cleanedBody = rewrittenBody;
  }

  const sendInlineReply = async (reply?: ReplyPayload) => {
    if (!reply) {
      return;
    }
    if (!opts?.onBlockReply) {
      return;
    }
    await opts.onBlockReply(reply);
  };

  const isStopLikeInbound = isAbortRequestText(command.rawBodyNormalized);
  if (!isStopLikeInbound && sessionEntry) {
    const cutoff = readAbortCutoffFromSessionEntry(sessionEntry);
    const incoming = resolveAbortCutoffFromContext(ctx);
    const shouldSkip = cutoff
      ? shouldSkipMessageByAbortCutoff({
          cutoffMessageSid: cutoff.messageSid,
          cutoffTimestamp: cutoff.timestamp,
          messageSid: incoming?.messageSid,
          timestamp: incoming?.timestamp,
        })
      : false;
    if (shouldSkip) {
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }
    if (cutoff) {
      await clearAbortCutoffInSession({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  const inlineCommand =
    allowTextCommands && command.isAuthorizedSender
      ? extractInlineSimpleCommand(cleanedBody)
      : null;
  if (inlineCommand) {
    cleanedBody = inlineCommand.cleaned;
    sessionCtx.Body = cleanedBody;
    sessionCtx.BodyForAgent = cleanedBody;
    sessionCtx.BodyStripped = cleanedBody;
  }

  const handleInlineStatus =
    !isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    }) && inlineStatusRequested;
  if (handleInlineStatus) {
    const inlineStatusReply = await buildStatusReply({
      cfg,
      command,
      sessionEntry,
      sessionKey,
      parentSessionKey: ctx.ParentSessionKey,
      sessionScope,
      provider,
      model,
      contextTokens,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      isGroup,
      defaultGroupActivation: defaultActivation,
      mediaDecisions: ctx.MediaUnderstandingDecisions,
    });
    await sendInlineReply(inlineStatusReply);
    directives = { ...directives, hasStatusDirective: false };
  }

  const runCommands = (commandInput: typeof command) =>
    handleCommands({
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
      sessionEntry,
      previousSessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      opts,
      defaultGroupActivation: defaultActivation,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      isGroup,
      skillCommands,
      typing,
    });

  if (inlineCommand) {
    const inlineCommandContext = {
      ...command,
      rawBodyNormalized: inlineCommand.command,
      commandBodyNormalized: inlineCommand.command,
    };
    const inlineResult = await runCommands(inlineCommandContext);
    if (inlineResult.reply) {
      if (!inlineCommand.cleaned) {
        typing.cleanup();
        return { kind: "reply", reply: inlineResult.reply };
      }
      await sendInlineReply(inlineResult.reply);
    }
  }

  if (directiveAck) {
    await sendInlineReply(directiveAck);
  }

  const isEmptyConfig = Object.keys(cfg).length === 0;
  const skipWhenConfigEmpty = command.channelId
    ? Boolean(getChannelDock(command.channelId)?.commands?.skipWhenConfigEmpty)
    : false;
  if (
    skipWhenConfigEmpty &&
    isEmptyConfig &&
    command.from &&
    command.to &&
    command.from !== command.to
  ) {
    typing.cleanup();
    return { kind: "reply", reply: undefined };
  }

  let abortedLastRun = initialAbortedLastRun;
  if (!sessionEntry && command.abortKey) {
    abortedLastRun = getAbortMemory(command.abortKey) ?? false;
  }

  const commandResult = await runCommands(command);
  if (!commandResult.shouldContinue) {
    typing.cleanup();
    return { kind: "reply", reply: commandResult.reply };
  }

  return {
    kind: "continue",
    directives,
    abortedLastRun,
  };
}
