// Legacy MCP runtime config migrations for CLI-native transport aliases.
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

const MCP_SERVER_TYPE_RULE: LegacyConfigRule = {
  path: ["mcp", "servers"],
  message:
    'mcp.servers entries use OpenClaw transport names; CLI-native type aliases are legacy here. Run "openclaw doctor --fix".',
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some((server) => isRecord(server) && isKnownCliMcpTypeAlias(server.type)),
};

const MCP_SERVER_DISABLED_RULE: LegacyConfigRule = {
  path: ["mcp", "servers"],
  message: 'mcp.servers entries use enabled instead of disabled. Run "openclaw doctor --fix".',
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some((server) => isRecord(server) && typeof server.disabled === "boolean"),
};

/** Legacy config migration specs for MCP server config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "mcp.servers.disabled->enabled",
    describe: "Move MCP server disabled aliases to enabled",
    legacyRules: [MCP_SERVER_DISABLED_RULE],
    apply: (raw, changes) => {
      const mcp = isRecord(raw.mcp) ? raw.mcp : undefined;
      const servers = isRecord(mcp?.servers) ? mcp?.servers : undefined;
      if (!servers) {
        return;
      }

      for (const [serverName, rawServer] of Object.entries(servers)) {
        if (!isRecord(rawServer) || typeof rawServer.disabled !== "boolean") {
          continue;
        }
        if (typeof rawServer.enabled !== "boolean") {
          rawServer.enabled = !rawServer.disabled;
          changes.push(
            `Moved mcp.servers.${serverName}.disabled ${rawServer.disabled} → enabled ${rawServer.enabled}.`,
          );
        } else {
          changes.push(
            `Removed mcp.servers.${serverName}.disabled (enabled ${rawServer.enabled} already set).`,
          );
        }
        delete rawServer.disabled;
      }
    },
  }),
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
];
