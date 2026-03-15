import { type CliErrorCode, ErrorSeverity } from "./error-codes.js";
import { type ErrorContext, FormattedError } from "./formatted-error.js";

/**
 * Comprehensive error message catalog for OpenClaw CLI
 * Each error includes:
 * - description: What went wrong
 * - suggestions: Actionable steps to fix
 * - docsUrl: Link to documentation
 */
export const ERROR_MESSAGES: Record<
  CliErrorCode,
  {
    description: string;
    suggestions: string[];
    severity: ErrorSeverity;
    docsUrl?: string;
  }
> = {
  // Authentication errors
  ERR_AUTH_FAILED: {
    description:
      "Authentication failed. Your credentials could not be verified by the gateway.",
    suggestions: [
      "Verify your API key or token is correct and not expired",
      "Try running `openclaw auth refresh` to refresh credentials",
      "Check that your gateway server is running: `openclaw gateway status`",
      "If using token auth, ensure the token hasn't been revoked",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/getting-started/authentication",
  },

  ERR_AUTH_TOKEN_EXPIRED: {
    description: "Your authentication token has expired and is no longer valid.",
    suggestions: [
      "Run `openclaw auth refresh` to refresh your token",
      "If that fails, log out and log in again: `openclaw auth logout && openclaw auth login`",
      "Check that your system clock is synchronized (time skew can cause this)",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/getting-started/authentication",
  },

  ERR_AUTH_TOKEN_INVALID: {
    description: "The provided authentication token is invalid or malformed.",
    suggestions: [
      "Verify that your token was copied correctly (no extra spaces or characters)",
      "Try using `openclaw auth login` to log in again and get a new token",
      "Check that you're using the correct authentication method for your setup",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/getting-started/authentication",
  },

  ERR_AUTH_MISSING: {
    description:
      "No authentication credentials found. OpenClaw couldn't find your API key or token.",
    suggestions: [
      "Run `openclaw auth login` to authenticate",
      "Or set your API key as an environment variable: `export OPENCLAW_AUTH_TOKEN=your_token`",
      "Check that ~/.openclaw/config/auth.json exists and is readable",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/getting-started/setup",
  },

  ERR_AUTH_PAIRING_REQUIRED: {
    description:
      "Device pairing is required. Your device is not yet paired with the OpenClaw gateway.",
    suggestions: [
      "Run `openclaw device pair` to initiate the pairing process",
      "Scan the QR code displayed with your device's OpenClaw app",
      "Ensure your gateway server is accessible from your device",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/setup/device-pairing",
  },

  // Configuration errors
  ERR_CONFIG_INVALID: {
    description:
      "Invalid configuration detected. Your configuration file contains invalid values or is malformed.",
    suggestions: [
      "Check your configuration file at ~/.openclaw/config/config.json",
      "Run `openclaw config validate` to check for issues",
      "Run `openclaw config doctor --fix` to auto-repair common issues",
      "Review the documentation for valid configuration options",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/configuration",
  },

  ERR_CONFIG_MISSING: {
    description:
      "Required configuration is missing. A necessary setting was not found in your configuration.",
    suggestions: [
      "Run `openclaw config init` to initialize configuration",
      "Run `openclaw config doctor --fix` to auto-fill missing values",
      "Manually add the missing value to ~/.openclaw/config/config.json",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/configuration",
  },

  ERR_CONFIG_PARSE: {
    description: "Failed to parse configuration file. The config file may be corrupted or invalid JSON.",
    suggestions: [
      "Check that your configuration file is valid JSON: `jq . ~/.openclaw/config/config.json`",
      "Back up and delete the corrupted file: `mv ~/.openclaw/config/config.json ~/.openclaw/config/config.json.bak`",
      "Run `openclaw config init` to create a fresh configuration",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/configuration",
  },

  ERR_CONFIG_FILE_NOT_FOUND: {
    description: "Configuration file not found. OpenClaw could not locate the expected configuration file.",
    suggestions: [
      "Run `openclaw config init` to create the default configuration",
      "Ensure the directory ~/.openclaw/config/ exists and is readable",
      "Check that you have permission to read/write in your home directory",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/configuration/initialization",
  },

  // Gateway errors
  ERR_GATEWAY_UNAVAILABLE: {
    description:
      "OpenClaw gateway is unavailable. The gateway server is not responding or not running.",
    suggestions: [
      "Check gateway status: `openclaw gateway status`",
      "Start the gateway if needed: `openclaw gateway start`",
      "Check that the gateway is listening on the configured port",
      "If using a remote gateway, verify network connectivity and firewall rules",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/gateway/troubleshooting",
  },

  ERR_GATEWAY_TIMEOUT: {
    description:
      "Gateway request timed out. The gateway took too long to respond to your request.",
    suggestions: [
      "Check your network connection speed",
      "Try the command again (may be temporary)",
      "Increase the request timeout: use `--timeout <ms>` flag if available",
      "Check gateway logs: `openclaw logs --follow`",
      "Restart the gateway: `openclaw gateway restart`",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/gateway/troubleshooting",
  },

  ERR_GATEWAY_CONNECTION_FAILED: {
    description: "Failed to connect to OpenClaw gateway. Connection could not be established.",
    suggestions: [
      "Verify gateway is running: `openclaw gateway status`",
      "Check the gateway URL configuration",
      "Verify network connectivity: `ping $(hostname -I)`",
      "Check firewall rules and network policies",
      "Review gateway logs: `openclaw logs --follow gateway`",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/gateway/troubleshooting",
  },

  ERR_GATEWAY_UNAUTHORIZED: {
    description: "Gateway rejected the request due to insufficient permissions or invalid credentials.",
    suggestions: [
      "Verify your gateway token is correct: `openclaw config get gateway.token`",
      "Refresh authentication: `openclaw auth refresh`",
      "Check that the user/role has permission for this operation",
      "Ensure you're connecting to the correct gateway instance",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/gateway/authentication",
  },

  // Permission errors
  ERR_PERMISSION_DENIED: {
    description:
      "Permission denied. You don't have the necessary permissions to perform this operation.",
    suggestions: [
      "Check your user role and permissions",
      "Contact your administrator to request access if needed",
      "Ensure you're logged in with the correct user account",
      "Run `openclaw auth whoami` to check your current identity",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/security/permissions",
  },

  ERR_PERMISSION_INSUFFICIENT: {
    description: "Insufficient permissions for this operation. Your current role doesn't have the required access.",
    suggestions: [
      "Request higher permissions from an administrator",
      "Use a different account that has the necessary permissions",
      "Check if this is an admin-only operation",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/security/permissions",
  },

  // Resource errors
  ERR_RESOURCE_NOT_FOUND: {
    description: "The requested resource could not be found.",
    suggestions: [
      "Verify the resource ID or name is correct",
      "Check that you're using the correct resource type",
      "List available resources to find the right one",
      "Ensure the resource hasn't been deleted",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/cli/reference",
  },

  ERR_RESOURCE_INVALID: {
    description: "Invalid resource specification. The resource data is malformed or invalid.",
    suggestions: [
      "Verify the resource format matches the specification",
      "Check for required fields in the resource definition",
      "Review the documentation for the correct schema",
      "Use `--help` on the command to see examples",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/cli/reference",
  },

  // Rate limiting
  ERR_RATE_LIMIT_EXCEEDED: {
    description:
      "Rate limit exceeded. Too many requests have been made in a short time. Please wait before trying again.",
    suggestions: [
      "Wait a few moments before retrying the command",
      "Reduce the frequency of requests",
      "Check if you're running parallel operations that could be serialized",
      "Consider using batch operations if available",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/rate-limiting",
  },

  // Model/Provider errors
  ERR_MODEL_NOT_FOUND: {
    description: "The specified AI model could not be found or is not available.",
    suggestions: [
      "Check the model name for typos",
      "List available models: `openclaw models list`",
      "Verify the model is enabled in your configuration",
      "Check that your provider has the model in their catalog",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/models",
  },

  ERR_PROVIDER_UNAVAILABLE: {
    description: "AI provider is unavailable or not responding. The upstream service may be down.",
    suggestions: [
      "Check the provider's status page for any outages",
      "Verify your provider credentials are still valid",
      "Try a different model or provider",
      "Retry after a few moments (might be temporary)",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/providers/troubleshooting",
  },

  ERR_PROVIDER_INVALID: {
    description: "Invalid or unsupported provider specified.",
    suggestions: [
      "Check the provider name for typos",
      "List available providers: `openclaw providers list`",
      "Ensure the provider is installed and enabled",
      "Check configuration for provider settings",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/providers",
  },

  // Network errors
  ERR_NETWORK_ERROR: {
    description: "Network error occurred. There was a problem with your network connection or the remote server.",
    suggestions: [
      "Check your internet connection",
      "Verify firewall and proxy settings if applicable",
      "Try the command again",
      "If using a proxy, ensure it's correctly configured",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/troubleshooting/network",
  },

  ERR_NETWORK_TIMEOUT: {
    description: "Network request timed out. The connection took too long to establish or complete.",
    suggestions: [
      "Check your network connection speed and stability",
      "Try again with increased timeout if the flag is available",
      "Check if there are network congestion or ISP issues",
      "Try using a wired connection if on WiFi",
    ],
    severity: ErrorSeverity.WARN,
    docsUrl: "https://docs.openclaw.ai/troubleshooting/network",
  },

  // Input validation errors
  ERR_INVALID_INPUT: {
    description: "Invalid input provided. The input doesn't meet the expected format or constraints.",
    suggestions: [
      "Check the command syntax: use `--help` to see the correct usage",
      "Verify all required parameters are provided",
      "Check for any invalid characters or encoding issues",
      "Review error details above for specific validation failures",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/cli/usage",
  },

  ERR_INVALID_ARGUMENT: {
    description: "Invalid command line argument. The provided argument is not recognized or invalid.",
    suggestions: [
      "Check argument syntax and spelling",
      "Use `--help` to see valid arguments for this command",
      "Ensure you're using the correct argument format (e.g., --key=value or --key value)",
      "Quote arguments that contain spaces: `--arg \"value with spaces\"`",
    ],
    severity: ErrorSeverity.ERROR,
    docsUrl: "https://docs.openclaw.ai/cli/reference",
  },

  // Internal errors
  ERR_INTERNAL_ERROR: {
    description: "An internal error occurred. This is likely a bug in OpenClaw.",
    suggestions: [
      "Try running the command again",
      "Check the error details and logs: `openclaw logs --follow`",
      "If the error persists, report it on GitHub with details",
      "Include the full error stack trace when reporting",
    ],
    severity: ErrorSeverity.FATAL,
    docsUrl: "https://docs.openclaw.ai/support",
  },
};

/**
 * Create a formatted error from a code and optional context
 */
export function createFormattedError(
  code: CliErrorCode,
  overrides?: {
    message?: string;
    suggestions?: string[];
    context?: ErrorContext;
    cause?: unknown;
  },
): FormattedError {
  const catalog = ERROR_MESSAGES[code];

  return new FormattedError({
    code,
    message: overrides?.message ?? catalog.description,
    description: catalog.description,
    suggestions: overrides?.suggestions ?? catalog.suggestions,
    severity: catalog.severity,
    docsUrl: catalog.docsUrl,
    context: overrides?.context,
    cause: overrides?.cause,
  });
}
