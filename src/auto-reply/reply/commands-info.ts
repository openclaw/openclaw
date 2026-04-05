import { getChannelPlugin } from "../../channels/plugins/index.js";
import { logVerbose } from "../../globals.js";
import { listSkillCommandsForAgents } from "../skill-commands.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  buildToolsMessage,
} from "../status-info.js";
import type { CommandHandler } from "./commands-types.js";

export const handleHelpCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/help") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /help from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return {
    shouldContinue: false,
    reply: { text: buildHelpMessage(params.cfg) },
  };
};

export const handleCommandsListCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/commands") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /commands from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const skillCommands =
    params.skillCommands ??
    listSkillCommandsForAgents({
      cfg: params.cfg,
      agentIds: params.agentId ? [params.agentId] : undefined,
    });
  const surface = params.ctx.Surface;
  const commandPlugin = surface ? getChannelPlugin(surface) : null;
  const paginated = buildCommandsMessagePaginated(params.cfg, skillCommands, {
    page: 1,
    surface,
  });
  const headerLines = [
    ...(params.agentId ? [`Agent: ${params.agentId}`] : []),
    ...(params.workspaceDir ? [`Workspace: ${params.workspaceDir}`] : []),
  ];
  const channelData = commandPlugin?.commands?.buildCommandsListChannelData?.({
    currentPage: paginated.currentPage,
    totalPages: paginated.totalPages,
    agentId: params.agentId,
  });
  if (channelData) {
    return {
      shouldContinue: false,
      reply: {
        text: headerLines.length
          ? [headerLines.join("\n"), "", paginated.text].join("\n")
          : paginated.text,
        channelData,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: headerLines.length
        ? [
            headerLines.join("\n"),
            "",
            buildCommandsMessage(params.cfg, skillCommands, { surface }),
          ].join("\n")
        : buildCommandsMessage(params.cfg, skillCommands, { surface }),
    },
  };
};

export const handleToolsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  let verbose = false;
  if (normalized === "/tools" || normalized === "/tools compact") {
    verbose = false;
  } else if (normalized === "/tools verbose") {
    verbose = true;
  } else if (normalized.startsWith("/tools ")) {
    return { shouldContinue: false, reply: { text: "Usage: /tools [compact|verbose]" } };
  } else {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /tools from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  try {
    const { resolveSessionAgentId } = await import("../../agents/agent-scope.js");
    const { resolveEffectiveToolInventory } =
      await import("../../agents/tools-effective-inventory.js");
    const { buildThreadingToolContext } = await import("./agent-runner-utils.js");
    const { resolveChannelAccountId } = await import("./channel-context.js");
    const { extractExplicitGroupId } = await import("./group-id.js");
    const { resolveReplyToMode } = await import("./reply-threading.js");
    const effectiveAccountId = resolveChannelAccountId({
      cfg: params.cfg,
      ctx: params.ctx,
      command: params.command,
    });
    const agentId =
      params.agentId ??
      resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
    const threadingContext = buildThreadingToolContext({
      sessionCtx: params.ctx,
      config: params.cfg,
      hasRepliedRef: undefined,
    });
    const result = resolveEffectiveToolInventory({
      cfg: params.cfg,
      agentId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      modelProvider: params.provider,
      modelId: params.model,
      messageProvider: params.command.channel,
      senderIsOwner: params.command.senderIsOwner,
      senderId: params.command.senderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      accountId: effectiveAccountId,
      currentChannelId: threadingContext.currentChannelId,
      currentThreadTs:
        typeof params.ctx.MessageThreadId === "string" ||
        typeof params.ctx.MessageThreadId === "number"
          ? String(params.ctx.MessageThreadId)
          : undefined,
      currentMessageId: threadingContext.currentMessageId,
      groupId: params.sessionEntry?.groupId ?? extractExplicitGroupId(params.ctx.From),
      groupChannel:
        params.sessionEntry?.groupChannel ?? params.ctx.GroupChannel ?? params.ctx.GroupSubject,
      groupSpace: params.sessionEntry?.space ?? params.ctx.GroupSpace,
      replyToMode: resolveReplyToMode(
        params.cfg,
        params.ctx.OriginatingChannel ?? params.ctx.Provider,
        effectiveAccountId,
        params.ctx.ChatType,
      ),
    });
    return {
      shouldContinue: false,
      reply: { text: buildToolsMessage(result, { verbose }) },
    };
  } catch (err) {
    const message = String(err);
    const text = message.includes("missing scope:")
      ? "You do not have permission to view available tools."
      : "Couldn't load available tools right now. Try again in a moment.";
    return {
      shouldContinue: false,
      reply: { text },
    };
  }
};

export const handleStatusCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const statusRequested =
    params.directives.hasStatusDirective || params.command.commandBodyNormalized === "/status";
  if (!statusRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /status from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const { buildStatusReply } = await import("./commands-status.js");
  const reply = await buildStatusReply({
    cfg: params.cfg,
    command: params.command,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    sessionScope: params.sessionScope,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    model: params.model,
    contextTokens: params.contextTokens,
    resolvedThinkLevel: params.resolvedThinkLevel,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
    resolvedReasoningLevel: params.resolvedReasoningLevel,
    resolvedElevatedLevel: params.resolvedElevatedLevel,
    resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel,
    isGroup: params.isGroup,
    defaultGroupActivation: params.defaultGroupActivation,
    mediaDecisions: params.ctx.MediaUnderstandingDecisions,
  });
  return { shouldContinue: false, reply };
};

export const handleContextCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/context" && !normalized.startsWith("/context ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /context from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const { buildContextReply } = await import("./commands-context-report.js");
  return { shouldContinue: false, reply: await buildContextReply(params) };
};

export const handleExportSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (
    normalized !== "/export-session" &&
    !normalized.startsWith("/export-session ") &&
    normalized !== "/export" &&
    !normalized.startsWith("/export ")
  ) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /export-session from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const { buildExportSessionReply } = await import("./commands-export-session.js");
  return { shouldContinue: false, reply: await buildExportSessionReply(params) };
};

export const handleWhoamiCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/whoami") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /whoami from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const senderId = params.ctx.SenderId ?? "";
  const senderUsername = params.ctx.SenderUsername ?? "";
  const lines = ["🧭 Identity", `Channel: ${params.command.channel}`];
  if (senderId) {
    lines.push(`User id: ${senderId}`);
  }
  if (senderUsername) {
    const handle = senderUsername.startsWith("@") ? senderUsername : `@${senderUsername}`;
    lines.push(`Username: ${handle}`);
  }
  if (params.ctx.ChatType === "group" && params.ctx.From) {
    lines.push(`Chat: ${params.ctx.From}`);
  }
  if (params.ctx.MessageThreadId != null) {
    lines.push(`Thread: ${params.ctx.MessageThreadId}`);
  }
  if (senderId) {
    lines.push(`AllowFrom: ${senderId}`);
  }
  return { shouldContinue: false, reply: { text: lines.join("\n") } };
};
