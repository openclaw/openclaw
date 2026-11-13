import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayAuthOptions } from "./gateway-secret-options.js";

type ClaudeChannelMode = "auto" | "on" | "off";

function isClaudeChannelMode(value: string): value is ClaudeChannelMode {
  return value === "auto" || value === "on" || value === "off";
}

/** Validates local `mcp serve` flags before any Gateway connection is attempted. */
export function resolveMcpServeOptions(opts: Record<string, unknown>) {
  const { gatewayToken, gatewayPassword } = resolveGatewayAuthOptions(opts);
  const claudeChannelMode = normalizeLowercaseStringOrEmpty(
    normalizeStringifiedOptionalString(opts.claudeChannelMode) ?? "auto",
  );
  if (!isClaudeChannelMode(claudeChannelMode)) {
    throw new Error('Invalid --claude-channel-mode value. Use "auto", "on", or "off".');
  }
  return {
    gatewayUrl: typeof opts.url === "string" ? opts.url : undefined,
    gatewayToken,
    gatewayPassword,
    claudeChannelMode,
    verbose: Boolean(opts.verbose),
  };
}
