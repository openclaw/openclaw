import {
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  canonicalizeConfiguredMcpServer,
  isKnownCliMcpTypeAlias,
} from "../../../config/mcp-config-normalize.js";
import { isRecord } from "./legacy-config-record-shared.js";

const MCP_SERVER_TIMEOUT_ALIASES = [
  ["connectTimeout", "connectionTimeoutMs"],
  ["connect_timeout", "connectionTimeoutMs"],
  ["timeout", "requestTimeoutMs"],
] as const;

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
    let server = entry;
    const disabled = server.disabled;
    if (typeof disabled === "boolean") {
      if (typeof server.enabled !== "boolean") {
        server.enabled = !disabled;
        changes.push(
          `Moved ${pathPrefix}.${serverName}.disabled ${disabled} → enabled ${!disabled}.`,
        );
      } else {
        changes.push(
          `Removed ${pathPrefix}.${serverName}.disabled ${disabled} because enabled is already set to ${server.enabled}.`,
        );
      }
      delete server.disabled;
    }
    for (const [alias, canonical] of MCP_SERVER_TIMEOUT_ALIASES) {
      if (!Object.hasOwn(server, alias)) {
        continue;
      }
      const value = server[alias];
      // Old runtime only honored positive alias seconds; canonical fields are
      // finite().positive(), so migrating 0/negative/overflow would fail validation.
      if (
        server[canonical] === undefined &&
        typeof value === "number" &&
        value > 0 &&
        Number.isFinite(value * 1_000)
      ) {
        server[canonical] = value * 1_000;
        changes.push(
          `Moved ${pathPrefix}.${serverName}.${alias} → ${canonical} (${value * 1_000} ms).`,
        );
      } else {
        changes.push(
          `Removed ${pathPrefix}.${serverName}.${alias} (${canonical} already set or alias invalid).`,
        );
      }
      delete server[alias];
    }
    if (hasMcpServerLegacyAliases(server) || isKnownCliMcpTypeAlias(server.type)) {
      server = canonicalizeConfiguredMcpServer(server);
      records[serverName] = server;
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
