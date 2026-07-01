/** Handles /mcp commands for showing and mutating configured MCP servers. */
import {
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
} from "../../agents/agent-bundle-mcp-runtime.js";
import type { McpToolCatalog } from "../../agents/agent-bundle-mcp-types.js";
import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "../../config/mcp-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parseMcpCommand } from "./mcp-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderMcpServerLiveLine(params: {
  serverName: string;
  catalog: McpToolCatalog;
  stale: boolean;
}): string {
  const { serverName, catalog, stale } = params;
  if (stale) {
    return `- ${serverName}: ♻️ config changed since last connect (stale)`;
  }
  const server = catalog.servers[serverName];
  if (server) {
    const toolLabel = server.toolCount === 1 ? "tool" : "tools";
    return `- ${serverName}: ✅ connected (${server.toolCount} ${toolLabel})`;
  }
  const diagnostic = catalog.diagnostics?.find((entry) => entry.serverName === serverName);
  if (diagnostic) {
    return `- ${serverName}: ⚠️ ${diagnostic.message}`;
  }
  return `- ${serverName}: ⏳ not yet discovered`;
}

/**
 * Renders observed session-runtime state alongside static /mcp show config.
 * Read-only: uses peekSessionMcpRuntime/peekCatalog, which must not create
 * runtimes or connect transports. Returns undefined (no section) when no
 * session runtime exists yet, preserving prior /mcp show output.
 */
function renderMcpLiveStateSection(params: {
  serverNames: string[];
  sessionKey: string;
  workspaceDir: string;
  cfg: OpenClawConfig;
}): string | undefined {
  const runtime = peekSessionMcpRuntime({ sessionKey: params.sessionKey });
  if (!runtime) {
    return undefined;
  }
  const catalog = runtime.peekCatalog();
  if (!catalog) {
    return "🩺 Live state (session): not yet discovered — connects on next agent MCP tool use.";
  }
  const configSummary = resolveSessionMcpConfigSummary({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const stale = runtime.configFingerprint !== configSummary.fingerprint;
  const lines = params.serverNames.map((serverName) =>
    renderMcpServerLiveLine({ serverName, catalog, stale }),
  );
  return ["🩺 Live state (session):", ...lines].join("\n");
}

/** Command handler for /mcp show/set/unset operations. */
export const handleMcpCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const mcpCommand = parseMcpCommand(params.command.commandBodyNormalized);
  if (!mcpCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/mcp");
  if (unauthorized) {
    return unauthorized;
  }
  const nonOwner = rejectNonOwnerCommand(params, "/mcp");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/mcp",
    configKey: "mcp",
  });
  if (disabled) {
    return disabled;
  }
  if (mcpCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${mcpCommand.message}` },
    };
  }

  if (mcpCommand.action === "show") {
    const loaded = await listConfiguredMcpServers();
    if (!loaded.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${loaded.error}` },
      };
    }
    if (mcpCommand.name) {
      const server = loaded.mcpServers[mcpCommand.name];
      if (!server) {
        return {
          shouldContinue: false,
          reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${loaded.path}.` },
        };
      }
      const liveState = renderMcpLiveStateSection({
        serverNames: [mcpCommand.name],
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
      });
      const text = renderJsonBlock(`🔌 MCP server "${mcpCommand.name}" (${loaded.path})`, server);
      return {
        shouldContinue: false,
        reply: { text: liveState ? `${text}\n\n${liveState}` : text },
      };
    }
    if (Object.keys(loaded.mcpServers).length === 0) {
      return {
        shouldContinue: false,
        reply: { text: `🔌 No MCP servers configured in ${loaded.path}.` },
      };
    }
    const liveState = renderMcpLiveStateSection({
      serverNames: Object.keys(loaded.mcpServers),
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
    });
    const text = renderJsonBlock(`🔌 MCP servers (${loaded.path})`, loaded.mcpServers);
    return {
      shouldContinue: false,
      reply: { text: liveState ? `${text}\n\n${liveState}` : text },
    };
  }

  const missingAdminScope = requireGatewayClientScope(params, {
    label: "/mcp write",
    allowedScopes: ["operator.admin"],
    missingText: "❌ /mcp set|unset requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  if (mcpCommand.action === "set") {
    const result = await setConfiguredMcpServer({
      name: mcpCommand.name,
      server: mcpCommand.value,
    });
    if (!result.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${result.error}` },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: `🔌 MCP server "${mcpCommand.name}" saved to ${result.path}.`,
      },
    };
  }

  const result = await unsetConfiguredMcpServer({ name: mcpCommand.name });
  if (!result.ok) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${result.error}` },
    };
  }
  if (!result.removed) {
    return {
      shouldContinue: false,
      reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${result.path}.` },
    };
  }
  return {
    shouldContinue: false,
    reply: { text: `🔌 MCP server "${mcpCommand.name}" removed from ${result.path}.` },
  };
};
