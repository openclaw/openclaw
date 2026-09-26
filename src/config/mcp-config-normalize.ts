// Normalizes MCP config records into canonical runtime shape.
import { normalizeLowercaseStringOrEmpty as normalizeMcpString } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../utils.js";

type ConfigMcpServers = Record<string, Record<string, unknown>>;
type OpenClawMcpHttpTransport = "sse" | "streamable-http";

const CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT: Record<string, OpenClawMcpHttpTransport | "stdio"> = {
  http: "streamable-http",
  "streamable-http": "streamable-http",
  sse: "sse",
  stdio: "stdio",
};

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

/** Returns a cloned map of object-shaped MCP server configs, dropping invalid entries. */
export function normalizeConfiguredMcpServers(value: unknown): ConfigMcpServers {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, server]) => isRecord(server))
      .map(([name, server]) => [name, { ...(server as Record<string, unknown>) }]),
  );
}
