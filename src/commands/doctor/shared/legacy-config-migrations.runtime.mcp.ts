// Legacy MCP runtime config migrations for CLI-native transport aliases.
import { listBlockedMcpStdioEnvKeys } from "../../../agents/mcp-config-shared.js";
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  isKnownCliMcpTypeAlias,
  resolveOpenClawMcpTransportAlias,
} from "../../../config/mcp-config-normalize.js";
import { isRecord } from "./legacy-config-record-shared.js";

function isCommandBearingMcpServer(server: unknown): server is Record<string, unknown> {
  return isRecord(server) && typeof server.command === "string" && server.command.trim().length > 0;
}

const MCP_BLOCKED_STDIO_ENV_RULE: LegacyConfigRule = {
  path: ["mcp", "servers"],
  message:
    'mcp.servers stdio env blocks contain keys blocked for startup safety; they are ignored at launch and fail config validation. Run "openclaw doctor --fix".',
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some(
      (server) =>
        isCommandBearingMcpServer(server) && listBlockedMcpStdioEnvKeys(server.env).length > 0,
    ),
};

const MCP_SERVER_TYPE_RULE: LegacyConfigRule = {
  path: ["mcp", "servers"],
  message:
    'mcp.servers entries use OpenClaw transport names; CLI-native type aliases are legacy here. Run "openclaw doctor --fix".',
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some((server) => isRecord(server) && isKnownCliMcpTypeAlias(server.type)),
};

/** Legacy config migration specs for MCP server config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "mcp.servers.type->transport",
    describe: "Move CLI-native MCP server type aliases to OpenClaw transport",
    legacyRules: [MCP_SERVER_TYPE_RULE],
    apply: (raw, changes) => {
      const mcp = isRecord(raw.mcp) ? raw.mcp : undefined;
      const servers = isRecord(mcp?.servers) ? mcp?.servers : undefined;
      if (!servers) {
        return;
      }

      for (const [serverName, rawServer] of Object.entries(servers)) {
        if (!isRecord(rawServer) || !isKnownCliMcpTypeAlias(rawServer.type)) {
          continue;
        }
        const rawType = typeof rawServer.type === "string" ? rawServer.type : "";
        const alias = resolveOpenClawMcpTransportAlias(rawServer.type);
        if (typeof rawServer.transport !== "string" && alias) {
          rawServer.transport = alias;
          changes.push(`Moved mcp.servers.${serverName}.type "${rawType}" → transport "${alias}".`);
        } else if (typeof rawServer.transport === "string") {
          changes.push(
            `Removed mcp.servers.${serverName}.type (transport "${rawServer.transport}" already set).`,
          );
        } else {
          changes.push(`Removed mcp.servers.${serverName}.type "${rawType}".`);
        }
        delete rawServer.type;
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "mcp.servers.env.blocked-stdio-keys",
    describe: "Remove env keys blocked for stdio startup safety from MCP servers",
    legacyRules: [MCP_BLOCKED_STDIO_ENV_RULE],
    apply: (raw, changes) => {
      const mcp = isRecord(raw.mcp) ? raw.mcp : undefined;
      const servers = isRecord(mcp?.servers) ? mcp?.servers : undefined;
      if (!servers) {
        return;
      }

      for (const [serverName, rawServer] of Object.entries(servers)) {
        if (!isCommandBearingMcpServer(rawServer)) {
          continue;
        }
        const env = isRecord(rawServer.env) ? rawServer.env : undefined;
        if (!env) {
          continue;
        }
        for (const key of listBlockedMcpStdioEnvKeys(env)) {
          delete env[key];
          changes.push(
            `Removed mcp.servers.${serverName}.env.${key} (blocked for stdio startup safety; set it on the gateway host process instead).`,
          );
        }
      }
    },
  }),
];
