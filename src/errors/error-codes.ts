/**
 * Standardized error codes for OpenClaw CLI
 * Format: ERR_CATEGORY_SPECIFIC
 * Examples: ERR_AUTH_FAILED, ERR_CONFIG_INVALID, ERR_GATEWAY_UNAVAILABLE
 */

export const CLI_ERROR_CODES = [
  // Authentication errors
  "ERR_AUTH_FAILED",
  "ERR_AUTH_TOKEN_EXPIRED",
  "ERR_AUTH_TOKEN_INVALID",
  "ERR_AUTH_MISSING",
  "ERR_AUTH_PAIRING_REQUIRED",

  // Configuration errors
  "ERR_CONFIG_INVALID",
  "ERR_CONFIG_MISSING",
  "ERR_CONFIG_PARSE",
  "ERR_CONFIG_FILE_NOT_FOUND",

  // Gateway/Connection errors
  "ERR_GATEWAY_UNAVAILABLE",
  "ERR_GATEWAY_TIMEOUT",
  "ERR_GATEWAY_CONNECTION_FAILED",
  "ERR_GATEWAY_UNAUTHORIZED",

  // Permission errors
  "ERR_PERMISSION_DENIED",
  "ERR_PERMISSION_INSUFFICIENT",

  // Resource errors
  "ERR_RESOURCE_NOT_FOUND",
  "ERR_RESOURCE_INVALID",

  // Rate limiting
  "ERR_RATE_LIMIT_EXCEEDED",

  // Model/Provider errors
  "ERR_MODEL_NOT_FOUND",
  "ERR_PROVIDER_UNAVAILABLE",
  "ERR_PROVIDER_INVALID",

  // Network errors
  "ERR_NETWORK_ERROR",
  "ERR_NETWORK_TIMEOUT",

  // Input validation errors
  "ERR_INVALID_INPUT",
  "ERR_INVALID_ARGUMENT",

  // Internal errors
  "ERR_INTERNAL_ERROR",
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export function isCliErrorCode(value: unknown): value is CliErrorCode {
  if (typeof value !== "string") return false;
  return (CLI_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  FATAL = "FATAL",
}
