import { isDeepStrictEqual } from "node:util";
import {
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  isKnownCliMcpTypeAlias,
  MCP_SERVER_TIMEOUT_ALIASES,
  migrateLegacyConfiguredMcpServer,
} from "../../../config/mcp-config-normalize.js";
import { isRecord } from "./legacy-config-record-shared.js";

function mcpServerRules(
  message: string,
  match: (server: Record<string, unknown>) => boolean,
): LegacyConfigRule[] {
  return [
    ["mcp", "servers"],
    ["nodeHost", "mcp", "servers"],
  ].map((path) => ({
    path,
    message: `${path.join(".")} ${message}`,
    match: (value) =>
      isRecord(value) && Object.values(value).some((server) => isRecord(server) && match(server)),
  }));
}

function hasMcpServerLegacyAliases(server: Record<string, unknown>): boolean {
  const codex = isRecord(server.codex) ? server.codex : undefined;
  return (
    Object.hasOwn(server, "workingDirectory") ||
    ["supports_parallel_tool_calls", "ssl_verify", "client_cert", "client_key"].some((key) =>
      Object.hasOwn(server, key),
    ) ||
    Boolean(codex && Object.hasOwn(codex, "default_tools_approval_mode"))
  );
}

function migrateMcpServers(servers: unknown, pathPrefix: string, changes: string[]): void {
  const records = getRecord(servers);
  if (!records) {
    return;
  }
  for (const [serverName, entry] of Object.entries(records)) {
    if (!isRecord(entry)) {
      continue;
    }
    const normalized = migrateLegacyConfiguredMcpServer(entry);
    if (!isDeepStrictEqual(normalized, entry)) {
      records[serverName] = normalized;
      changes.push(`Canonicalized legacy aliases in ${pathPrefix}.${serverName}.`);
    }
  }
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP: LegacyConfigMigrationSpec[] = [
  {
    id: "mcp.servers.canonicalize",
    legacyRules: [
      ...mcpServerRules(
        'entries use the unsupported "disabled" key; use "enabled" with the inverse boolean value. Run "openclaw doctor --fix" to migrate it.',
        (server) => typeof server.disabled === "boolean",
      ),
      ...mcpServerRules(
        'entries use OpenClaw transport names; CLI-native type aliases are legacy here. Run "openclaw doctor --fix".',
        (server) => isKnownCliMcpTypeAlias(server.type),
      ),
      ...mcpServerRules(
        'timeout aliases were retired; use connectionTimeoutMs and requestTimeoutMs. Run "openclaw doctor --fix".',
        (server) => MCP_SERVER_TIMEOUT_ALIASES.some(([key]) => Object.hasOwn(server, key)),
      ),
      ...mcpServerRules(
        'legacy aliases were retired; use camelCase spellings and cwd. Run "openclaw doctor --fix".',
        hasMcpServerLegacyAliases,
      ),
    ],
    apply: (raw, changes) => {
      const mcp = getRecord(raw.mcp);
      const nodeHostMcp = getRecord(getRecord(raw.nodeHost)?.mcp);
      for (const [owner, path] of [
        [mcp, "mcp.servers"],
        [nodeHostMcp, "nodeHost.mcp.servers"],
      ] as const) {
        migrateMcpServers(owner?.servers, path, changes);
      }
    },
  },
];
