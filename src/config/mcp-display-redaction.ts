// Display-only MCP server redaction shared by chat `/mcp show` and the `openclaw mcp` CLI.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { redactSensitiveArgv } from "./redact-argv.js";
import { REDACTED_SENTINEL, redactConfigObject } from "./redact-snapshot.js";
import { buildConfigSchemaCore } from "./schema.js";

function redactMcpServerArgsForDisplay(server: unknown): unknown {
  if (!isRecord(server)) {
    return server;
  }
  const args = server.args;
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    return server;
  }
  return {
    ...server,
    args: redactSensitiveArgv(args, REDACTED_SENTINEL),
  };
}

/** Redact MCP server secrets before display; runtime and mutations keep the original values. */
export function redactMcpServersForDisplay(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const argvRedacted = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, redactMcpServerArgsForDisplay(server)]),
  );
  return redactConfigObject({ mcp: { servers: argvRedacted } }, buildConfigSchemaCore().uiHints).mcp
    .servers;
}
