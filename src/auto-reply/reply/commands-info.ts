import {
  resolveEffectiveToolInventory,
  acquireEffectiveToolInventoryRuntimeModelContext,
} from "../../agents/tools-effective-inventory.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import {
  prepareSkillCommandsForAgents,
  resolveSkillCommandInvocation,
} from "../../skills/discovery/chat-commands.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  buildToolsMessage,
} from "../status.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import { resolveChannelAccountId } from "./channel-context.js";
import {
  commandReply,
  defineAuthorizedTextCommand,
  matchCommandPrefix,
  rejectUnauthorizedCommand,
} from "./command-gates.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import { buildExportTrajectoryCommandReply } from "./commands-export-trajectory.js";
import { buildStatusPluginsReply, buildStatusReply } from "./commands-status.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { extractExplicitGroupId } from "./group-id.js";
import { resolveReplyToMode } from "./reply-threading.js";

async function resolveSkillCommands(params: HandleCommandsParams, requireFullList = false) {
  if (
    params.skillCommands !== undefined &&
    (!requireFullList || params.skillCommands.length > 0 || !params.loadSkillCommands)
  ) {
    return params.skillCommands;
  }
  if (params.loadSkillCommands) {
    return params.loadSkillCommands();
  }
  return prepareSkillCommandsForAgents({
    cfg: params.cfg,
    agentIds: [params.agentId],
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
  });
}

export const handleHelpCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/help", match: (body) => (body === "/help" ? true : null), silentUnauthorized: true },
  (params) => commandReply(buildHelpMessage(params.cfg)),
);

export const handleCommandsListCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/commands",
    match: (body) => (body === "/commands" ? true : null),
    silentUnauthorized: true,
  },
  async (params) => {
    const skillCommands = await resolveSkillCommands(params);
    const surface = params.ctx.Surface;
    const commandPlugin = surface ? getChannelPlugin(surface) : null;
    const paginated = buildCommandsMessagePaginated(params.cfg, skillCommands, {
      page: 1,
      surface,
    });
    const channelData = commandPlugin?.commands?.buildCommandsListChannelData?.({
      currentPage: paginated.currentPage,
      totalPages: paginated.totalPages,
      agentId: params.agentId,
    });
    if (channelData) {
      return commandReply({ text: paginated.text, channelData });
    }

    return commandReply(buildCommandsMessage(params.cfg, skillCommands, { surface }));
  },
);

function buildSkillCommandUsage(skillCommands: NonNullable<HandleCommandsParams["skillCommands"]>) {
  const lines = ["Usage: /skill <name> [input]"];
  if (skillCommands.length > 0) {
    const names = skillCommands.slice(0, 8).map((command) => command.skillName || command.name);
    lines.push("", `Available: ${names.join(", ")}`);
    lines.push(
      `More: /commands${skillCommands.length > names.length ? ` (${skillCommands.length - names.length} more)` : ""}`,
    );
  } else {
    lines.push("", "Use /commands to list available skill commands.");
  }
  return lines.join("\n");
}

export const handleSkillCommandUsage: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/skill",
    match: (body) => matchCommandPrefix(body, "/skill"),
    silentUnauthorized: true,
  },
  async (params) => {
    const normalized = params.command.commandBodyNormalized;
    // Bare or unknown /skill commands are deterministic help responses; handling
    // them here avoids falling through into a full agent/model turn.
    const [, rawName] = normalized.match(/^\/skill(?:\s+([^\s]+))?/u) ?? [];
    const skillCommands = await resolveSkillCommands(params, true);
    if (
      rawName &&
      resolveSkillCommandInvocation({ commandBodyNormalized: normalized, skillCommands })
    ) {
      return null;
    }
    const prefix = rawName ? `Unknown skill: ${rawName}\n\n` : "";
    return commandReply(`${prefix}${buildSkillCommandUsage(skillCommands)}`);
  },
);

export const handleToolsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  let verbose;
  if (normalized === "/tools" || normalized === "/tools compact") {
    verbose = false;
  } else if (normalized === "/tools verbose") {
    verbose = true;
  } else if (normalized.startsWith("/tools ")) {
    return commandReply("Usage: /tools [compact|verbose]");
  } else {
    return null;
  }
  if (rejectUnauthorizedCommand(params, "/tools")) {
    return { shouldContinue: false };
  }

  try {
    const effectiveAccountId = resolveChannelAccountId({
      cfg: params.cfg,
      ctx: params.ctx,
      command: params.command,
    });
    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const sessionBound = Boolean(params.sessionKey);
    const threadingContext = buildThreadingToolContext({
      sessionCtx: params.ctx,
      config: params.cfg,
      hasRepliedRef: undefined,
    });
    const inventoryModelContext = () => ({
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: sessionBound ? undefined : params.agentDir,
      workspaceDir: params.workspaceDir,
      modelProvider: params.provider,
      modelId: params.model,
    });
    await using acquired =
      await acquireEffectiveToolInventoryRuntimeModelContext(inventoryModelContext());
    return await acquired.run(async (runtimeModelContext) => {
      const result = await resolveEffectiveToolInventory({
        ...inventoryModelContext(),
        sessionKey: params.sessionKey,
        modelApi: runtimeModelContext.modelApi,
        runtimeModel: runtimeModelContext.runtimeModel,
        messageProvider: params.command.channel,
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
        groupId: targetSessionEntry?.groupId ?? extractExplicitGroupId(params.ctx.From),
        groupChannel:
          targetSessionEntry?.groupChannel ?? params.ctx.GroupChannel ?? params.ctx.GroupSubject,
        groupSpace: targetSessionEntry?.space ?? params.ctx.GroupSpace,
        replyToMode: resolveReplyToMode(
          params.cfg,
          params.ctx.OriginatingChannel ?? params.ctx.Provider,
          effectiveAccountId,
          params.ctx.ChatType,
        ),
      });
      return commandReply(buildToolsMessage(result, { verbose }));
    });
  } catch {
    // Inventory resolves in-process after sender authorization; this path cannot receive
    // gateway RPC scope errors, so failures here are local discovery failures.
    return commandReply("Couldn't load available tools right now. Try again in a moment.");
  }
};

export const handleStatusCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/status",
    match: (body, params) => {
      const normalized = body.trim();
      return params.directives.hasStatusDirective ||
        matchCommandPrefix(normalized, "/status") !== null
        ? normalized
        : null;
    },
    silentUnauthorized: true,
  },
  async (params, normalizedStatusCommand) => {
    if (normalizedStatusCommand === "/status plugins") {
      const reply = await buildStatusPluginsReply({
        cfg: params.cfg,
        command: params.command,
        workspaceDir: params.workspaceDir,
      });
      return commandReply(reply);
    }
    if (normalizedStatusCommand.startsWith("/status ")) {
      return commandReply(
        setReplyPayloadMetadata(
          { text: "⚠️ Unknown /status subcommand. Try /status or /status plugins." },
          { contextFreeCommand: true },
        ),
      );
    }
    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const reply = await buildStatusReply({
      ...params,
      sessionEntry: targetSessionEntry,
      parentSessionKey: targetSessionEntry?.parentSessionKey ?? params.ctx.ParentSessionKey,
      mediaDecisions: params.ctx.MediaUnderstandingDecisions,
    });
    return commandReply(reply);
  },
);

export const handleExportSessionCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/export-session",
    match: (body) =>
      matchCommandPrefix(body, "/export-session") ?? matchCommandPrefix(body, "/export"),
    ownerOnly: true,
  },
  async (params) => commandReply(await buildExportSessionReply(params)),
);

export const handleExportTrajectoryCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/export-trajectory",
    match: (body) =>
      matchCommandPrefix(body, "/export-trajectory") ?? matchCommandPrefix(body, "/trajectory"),
    ownerOnly: true,
  },
  async (params) => commandReply(await buildExportTrajectoryCommandReply(params)),
);
