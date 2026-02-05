/**
 * Centralized timeout configuration for CLI, gateway, and tool-specific commands
 * Provides consistent timeout management across all execution paths
 */

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
export const DEFAULT_CLI_TIMEOUT_MS = 10_000;
export const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000;

/**
 * Parse and validate timeout from environment variable
 * Returns default if value is invalid (non-positive or NaN)
 */
function parseTimeoutMs(value: string | undefined, defaultMs: number): number {
  if (!value) return defaultMs;

  const parsed = Number.parseInt(value, 10);

  // Validate: must be finite and positive
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[Timeout Config] Invalid timeout value "${value}". Using default ${defaultMs}ms`,
    );
    return defaultMs;
  }

  return parsed;
}

/**
 * Get CLI command timeout with validation
 * Priority: OPENCLAW_CLI_TIMEOUT_MS env var > default
 */
export function getCliTimeoutMs(): number {
  return parseTimeoutMs(
    process.env.OPENCLAW_CLI_TIMEOUT_MS,
    DEFAULT_CLI_TIMEOUT_MS,
  );
}

/**
 * Get tool-specific timeout with validation
 * Priority: OPENCLAW_TOOL_<NAME>_TIMEOUT_MS > OPENCLAW_TOOL_TIMEOUT_MS > default
 */
export function getToolTimeoutMs(toolName?: string): number {
  // Check tool-specific env var first
  if (toolName) {
    const toolEnvVar = `OPENCLAW_TOOL_${toolName.toUpperCase()}_TIMEOUT_MS`;
    const toolTimeout = parseTimeoutMs(
      process.env[toolEnvVar],
      -1,
    );

    if (toolTimeout > 0) {
      return toolTimeout;
    }
  }

  // Check global tool env var
  const globalToolTimeout = parseTimeoutMs(
    process.env.OPENCLAW_TOOL_TIMEOUT_MS,
    -1,
  );

  if (globalToolTimeout > 0) {
    return globalToolTimeout;
  }

  return DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Get gateway timeout with validation
 * Priority: OPENCLAW_GATEWAY_TIMEOUT_MS env var > default
 */
export function getGatewayTimeoutMs(): number {
  return parseTimeoutMs(
    process.env.OPENCLAW_GATEWAY_TIMEOUT_MS,
    DEFAULT_GATEWAY_TIMEOUT_MS,
  );
}
