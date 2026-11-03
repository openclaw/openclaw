// Normalizes MCP config records into canonical runtime shape.
import { isDeepStrictEqual } from "node:util";
import {
  readNonBlankString,
  normalizeLowercaseStringOrEmpty as normalizeMcpString,
} from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../utils.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

type OpenClawMcpHttpTransport = "sse" | "streamable-http";

const CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT: Record<string, OpenClawMcpHttpTransport | "stdio"> = {
  http: "streamable-http",
  "streamable-http": "streamable-http",
  sse: "sse",
  stdio: "stdio",
};

export const MCP_SERVER_TIMEOUT_ALIASES = [
  ["connectTimeout", "connectionTimeoutMs"],
  ["connect_timeout", "connectionTimeoutMs"],
  ["timeout", "requestTimeoutMs"],
] as const;

/** Strict writes reject ambiguity; runtime reads retain legacy behavior with a warning. */
export function collectMcpTransportIssues(
  config: OpenClawConfig,
  baseline?: OpenClawConfig,
): ConfigValidationIssue[] {
  return (
    [
      ["mcp.servers", config.mcp?.servers, baseline?.mcp?.servers],
      ["nodeHost.mcp.servers", config.nodeHost?.mcp?.servers, baseline?.nodeHost?.mcp?.servers],
    ] as const
  ).flatMap(([path, servers, previous]) =>
    Object.entries(servers ?? {}).flatMap(([name, server]) => {
      const existing = previous?.[name];
      if (!readNonBlankString(server.command) || !readNonBlankString(server.url)) {
        return [];
      }
      // A repair's prior snapshot can be invalid outside this server entry.
      if (
        isRecord(existing) &&
        isDeepStrictEqual(
          canonicalizeConfiguredMcpServer(server),
          migrateLegacyConfiguredMcpServer(existing),
        )
      ) {
        return [];
      }
      return [
        {
          path: `${path}.${name}`,
          message:
            'MCP server cannot combine "command" and "url"; remove "command" and stdio options for HTTP, or remove "url" and HTTP/auth options for stdio. Doctor will not choose a transport.',
        },
      ];
    }),
  );
}

/** Reads the canonical transport prepared by config migration or bundle ingestion. */
export function resolveConfiguredMcpTransport(server: unknown): string | undefined {
  return isRecord(server) ? normalizeMcpString(server.transport) || undefined : undefined;
}

/** Maps CLI-native MCP type aliases to OpenClaw HTTP transport names. */
export function resolveOpenClawMcpTransportAlias(
  value: unknown,
): OpenClawMcpHttpTransport | undefined {
  const mapped = CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT[normalizeMcpString(value)];
  return mapped === "sse" || mapped === "streamable-http" ? mapped : undefined;
}

/** Checks whether a raw MCP `type` value is a legacy CLI alias OpenClaw can rewrite. */
export function isKnownCliMcpTypeAlias(value: unknown): boolean {
  return Object.hasOwn(CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT, normalizeMcpString(value));
}

/**
 * Converts operator-friendly MCP server aliases into canonical config keys.
 *
 * Existing canonical fields win over legacy snake_case or `type` aliases so
 * repeated configure commands cannot overwrite already-normalized choices.
 */
export function canonicalizeConfiguredMcpServer(
  server: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...server };
  const transportAlias = resolveOpenClawMcpTransportAlias(next.type);
  // `transport` is OpenClaw's canonical field; legacy `type` only fills a gap.
  if (typeof next.transport !== "string" && transportAlias) {
    next.transport = transportAlias;
  }
  if (isKnownCliMcpTypeAlias(next.type)) {
    delete next.type;
  }
  for (const [legacy, canonical, type] of [
    ["workingDirectory", "cwd", "string"],
    ["supports_parallel_tool_calls", "supportsParallelToolCalls", "boolean"],
    ["ssl_verify", "sslVerify", "boolean"],
    ["client_cert", "clientCert", "string"],
    ["client_key", "clientKey", "string"],
  ] as const) {
    if (typeof next[legacy] === type && typeof next[canonical] !== type) {
      next[canonical] = next[legacy];
    }
    delete next[legacy];
  }
  const codex = isRecord(next.codex) ? { ...next.codex } : undefined;
  if (codex) {
    if (
      typeof codex.defaultToolsApprovalMode !== "string" &&
      typeof codex.default_tools_approval_mode === "string"
    ) {
      codex.defaultToolsApprovalMode = codex.default_tools_approval_mode;
    }
    delete codex.default_tools_approval_mode;
    next.codex = codex;
  }
  return next;
}

/** Doctor and compatibility comparisons share the retired-key migration semantics. */
export function migrateLegacyConfiguredMcpServer(
  server: Record<string, unknown>,
): Record<string, unknown> {
  const next = canonicalizeConfiguredMcpServer(server);
  if (typeof next.disabled === "boolean") {
    if (typeof next.enabled !== "boolean") {
      next.enabled = !next.disabled;
    }
    delete next.disabled;
  }
  for (const [alias, canonical] of MCP_SERVER_TIMEOUT_ALIASES) {
    if (!Object.hasOwn(next, alias)) {
      continue;
    }
    const value = next[alias];
    // Retired timeouts were seconds; preserve canonical values and discard invalid aliases.
    if (
      next[canonical] === undefined &&
      typeof value === "number" &&
      value > 0 &&
      Number.isFinite(value * 1_000)
    ) {
      next[canonical] = value * 1_000;
    }
    delete next[alias];
  }
  return next;
}
