/** Handles /mcp commands for showing and mutating configured MCP servers. */
import {
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
} from "../../agents/agent-bundle-mcp-tools.js";
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
  disabled: boolean;
  catalog: McpToolCatalog | null;
  stale: boolean;
}): string {
  const { serverName, disabled, catalog, stale } = params;
  // Disabled state always wins: enabled:false servers never attempt a
  // connection, so they must not be labeled "warming up"/"stale" even when
  // the session catalog itself isn't built yet (catalog === null).
  if (disabled) {
    return `- ${serverName}: 🚫 disabled (enabled: false, excluded from runtime)`;
  }
  if (!catalog) {
    return `- ${serverName}: ⏳ not yet discovered — connects on next agent MCP tool use.`;
  }
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
  servers: Record<string, unknown>;
  sessionKey: string;
  cfg: OpenClawConfig;
}): string | undefined {
  const runtime = peekSessionMcpRuntime({ sessionKey: params.sessionKey });
  if (!runtime) {
    return undefined;
  }
  const catalog = runtime.peekCatalog();
  // Compare against the same workspace-derived fingerprint the runtime was
  // built from (runtime.workspaceDir), not the command's raw workspaceDir:
  // sandboxed sessions resolve MCP config from a different effective
  // workspace, so comparing against the command's own workspaceDir would
  // misreport every server as stale. Mirrors tools-effective.ts.
  const stale = catalog
    ? runtime.configFingerprint !==
      resolveSessionMcpConfigSummary({ workspaceDir: runtime.workspaceDir, cfg: params.cfg })
        .fingerprint
    : false;
  const lines = Object.entries(params.servers).map(([serverName, server]) => {
    const disabled = Boolean(
      server && typeof server === "object" && (server as { enabled?: unknown }).enabled === false,
    );
    return renderMcpServerLiveLine({ serverName, disabled, catalog, stale });
  });
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
        servers: { [mcpCommand.name]: server },
        sessionKey: params.sessionKey,
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
      servers: loaded.mcpServers,
      sessionKey: params.sessionKey,
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
