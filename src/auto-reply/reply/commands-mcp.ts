import {
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "../../agents/mcp-config-mutation.js";
import { listConfiguredMcpServers, redactMcpServersForDisplay } from "../../config/mcp-config.js";
import type { ReplyPayload } from "../types.js";
import {
  commandReply,
  defineAuthorizedTextCommand,
  renderCommandJsonBlock,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import {
  deliverPrivateCommandReply,
  resolvePrivateCommandRouteTargets,
} from "./commands-private-route.js";
import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner route for MCP configuration. Run /mcp show from an owner DM so sensitive server details are not posted in this chat.";
const MCP_SHOW_PRIVATE_ROUTE_REPLIES = {
  delivered: "MCP server configuration is sensitive. I sent the details to the owner privately.",
  pending:
    "MCP server configuration is sensitive. Private delivery is pending; I can't confirm receipt yet.",
  suppressed:
    "MCP server configuration is sensitive. Private delivery was suppressed; no details were sent.",
  failed: MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE,
};

async function buildMcpShowReply(name?: string): Promise<ReplyPayload> {
  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return { text: `⚠️ ${loaded.error}` };
  }
  if (name) {
    const server = loaded.mcpServers[name];
    if (!server) {
      return { text: `🔌 No MCP server named "${name}" in ${loaded.path}.` };
    }
    const redactedServer = redactMcpServersForDisplay({
      [name]: server,
    })[name];
    return {
      text: renderCommandJsonBlock(`🔌 MCP server "${name}" (${loaded.path})`, redactedServer),
    };
  }
  if (Object.keys(loaded.mcpServers).length === 0) {
    return { text: `🔌 No MCP servers configured in ${loaded.path}.` };
  }
  return {
    text: renderCommandJsonBlock(
      `🔌 MCP servers (${loaded.path})`,
      redactMcpServersForDisplay(loaded.mcpServers),
    ),
  };
}

async function deliverGroupMcpShowReplyPrivately(params: HandleCommandsParams, name?: string) {
  const targets = await resolvePrivateCommandRouteTargets({
    commandParams: params,
    id: "mcp-show-private-route",
    command: params.command.commandBodyNormalized,
  });
  if (targets.length === 0) {
    return commandReply(MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE);
  }
  const privateReply = await buildMcpShowReply(name);
  const outcome = await deliverPrivateCommandReply({
    commandParams: params,
    targets,
    reply: privateReply,
  });
  return commandReply(MCP_SHOW_PRIVATE_ROUTE_REPLIES[outcome]);
}

/** Command handler for /mcp show/set/unset operations. */
export const handleMcpCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/mcp",
    match: (raw) =>
      parseSlashCommandWithSetUnset<{ action: "show"; name?: string }>({
        raw,
        slash: "/mcp",
        usageMessage: "Usage: /mcp show|set|unset",
        onKnownAction: (action, args) => {
          if (action === "show" || action === "get") {
            return { action: "show", name: args || undefined };
          }
          return undefined;
        },
      }),
    ownerOnly: true,
  },
  async (params, mcpCommand) => {
    const disabled = requireCommandFlagEnabled(params.cfg, {
      label: "/mcp",
      configKey: "mcp",
    });
    if (disabled) {
      return disabled;
    }
    if (mcpCommand.action === "error") {
      return commandReply(`⚠️ ${mcpCommand.message}`);
    }

    if (mcpCommand.action === "show") {
      if (params.isGroup) {
        return await deliverGroupMcpShowReplyPrivately(params, mcpCommand.name);
      }
      return commandReply(await buildMcpShowReply(mcpCommand.name));
    }

    const missingAdminScope = requireGatewayClientScope(params, {
      label: "/mcp write",
      allowedScopes: ["operator.admin"],
      missingText: "❌ /mcp set|unset requires operator.admin for gateway clients.",
    });
    if (missingAdminScope) {
      return missingAdminScope;
    }

    const mutation = {
      name: mcpCommand.path,
      assertCurrent: params.command.assertOwnerCurrent,
    };
    const result =
      mcpCommand.action === "set"
        ? await setConfiguredMcpServer({ ...mutation, server: mcpCommand.value })
        : await unsetConfiguredMcpServer(mutation);
    if (!result.ok) {
      return commandReply(`⚠️ ${result.error}`);
    }
    if (mcpCommand.action === "set") {
      return commandReply(`🔌 MCP server "${mcpCommand.path}" saved to ${result.path}.`);
    }
    if (!result.removed) {
      return commandReply(`🔌 No MCP server named "${mcpCommand.path}" in ${result.path}.`);
    }
    return commandReply(`🔌 MCP server "${mcpCommand.path}" removed from ${result.path}.`);
  },
);
