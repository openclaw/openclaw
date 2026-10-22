// Display-only MCP server redaction shared by chat `/mcp show` and the `openclaw mcp` CLI.
import { redactSensitiveArgv } from "./redact-argv.js";
import { REDACTED_SENTINEL, redactConfigObject } from "./redact-snapshot.js";
import { buildConfigSchemaCore } from "./schema.js";

function redactMcpServerArgsForDisplay(server: unknown): unknown {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return server;
  }
  const record = server as Record<string, unknown>;
  if (!Array.isArray(record.args) || !record.args.every((arg) => typeof arg === "string")) {
    return server;
  }
  return {
    ...record,
    args: redactSensitiveArgv(record.args, REDACTED_SENTINEL),
  };
}

/** Redact MCP server secrets before display; runtime and mutations keep the original values. */
export function redactMcpServersForDisplay(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const argvRedacted = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, redactMcpServerArgsForDisplay(server)]),
  );
  const redactedRoot = redactConfigObject(
    { mcp: { servers: argvRedacted } },
    buildConfigSchemaCore().uiHints,
  ) as {
    mcp?: { servers?: Record<string, unknown> };
  };
  return redactedRoot.mcp?.servers ?? {};
}
