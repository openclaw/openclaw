import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

export type OnboardingErrorContext = {
  step: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  error: Error;
};

export type ErrorRecoveryAction = {
  type: "retry" | "skip" | "fix" | "abort";
  message: string;
  fixCommand?: string;
  docUrl?: string;
};

/**
 * Categorize onboarding errors for better handling.
 */
export function categorizeOnboardingError(error: Error): {
  category: string;
  isRecoverable: boolean;
  isTransient: boolean;
} {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Network errors
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    name.includes("network")
  ) {
    return {
      category: "network",
      isRecoverable: true,
      isTransient: true,
    };
  }

  // Permission errors
  if (
    message.includes("permission") ||
    message.includes("eacces") ||
    message.includes("eperm") ||
    name.includes("permission")
  ) {
    return {
      category: "permission",
      isRecoverable: true,
      isTransient: false,
    };
  }

  // Config errors
  if (
    message.includes("config") ||
    message.includes("invalid") ||
    message.includes("validation") ||
    name.includes("config")
  ) {
    return {
      category: "config",
      isRecoverable: true,
      isTransient: false,
    };
  }

  // OAuth errors
  if (
    message.includes("oauth") ||
    message.includes("authentication") ||
    message.includes("unauthorized") ||
    message.includes("401") ||
    message.includes("403")
  ) {
    return {
      category: "auth",
      isRecoverable: true,
      isTransient: false,
    };
  }

  // Port/service errors
  if (
    message.includes("port") ||
    message.includes("eaddrinuse") ||
    message.includes("already in use")
  ) {
    return {
      category: "port",
      isRecoverable: true,
      isTransient: false,
    };
  }

  // Unknown errors
  return {
    category: "unknown",
    isRecoverable: false,
    isTransient: false,
  };
}

/**
 * Format error message with context and actionable fixes.
 */
export function formatOnboardingError(
  context: OnboardingErrorContext,
  runtime: RuntimeEnv,
): string {
  const { step, error } = context;
  const categorized = categorizeOnboardingError(error);
  const lines: string[] = [];

  lines.push(`Error during ${step}:`);
  lines.push(`  ${error.message}`);

  if (categorized.category === "network") {
    lines.push("");
    lines.push("This appears to be a network connectivity issue.");
    lines.push("Possible fixes:");
    lines.push("  - Check your internet connection");
    lines.push("  - Verify firewall settings");
    lines.push("  - Try again in a few moments");
    lines.push(`  - Skip network checks: ${formatCliCommand("openclaw onboard --skip-preflight-network")}`);
  } else if (categorized.category === "permission") {
    lines.push("");
    lines.push("This appears to be a file permission issue.");
    lines.push("Possible fixes:");
    lines.push("  - Check file/directory permissions");
    lines.push("  - Ensure you have write access to the config directory");
    lines.push(`  - Run: chmod 755 ~/.openclaw`);
  } else if (categorized.category === "config") {
    lines.push("");
    lines.push("This appears to be a configuration issue.");
    lines.push("Possible fixes:");
    lines.push(`  - Run: ${formatCliCommand("openclaw doctor")} to repair config`);
    lines.push(`  - Delete invalid config and start fresh`);
    lines.push("  - Docs: https://docs.openclaw.ai/gateway/configuration");
  } else if (categorized.category === "auth") {
    lines.push("");
    lines.push("This appears to be an authentication issue.");
    lines.push("Possible fixes:");
    lines.push("  - Verify your API keys are correct");
    lines.push("  - Check OAuth token expiration");
    lines.push("  - Re-run authentication step");
    lines.push("  - Docs: https://docs.openclaw.ai/gateway/authentication");
  } else if (categorized.category === "port") {
    lines.push("");
    lines.push("This appears to be a port conflict.");
    lines.push("Possible fixes:");
    lines.push("  - Stop the service using the port");
    lines.push("  - Configure a different port during onboarding");
    lines.push(`  - Check what's using the port: lsof -i :18789`);
  }

  lines.push("");
  lines.push(`Docs: https://docs.openclaw.ai/gateway/troubleshooting`);

  return lines.join("\n");
}

/**
 * Generate recovery action for an error.
 */
export function generateRecoveryAction(
  context: OnboardingErrorContext,
): ErrorRecoveryAction {
  const { step, error } = context;
  const categorized = categorizeOnboardingError(error);

  if (categorized.category === "network" && categorized.isTransient) {
    return {
      type: "retry",
      message: "Network error detected. This may be temporary.",
      docUrl: "https://docs.openclaw.ai/gateway/troubleshooting",
    };
  }

  if (categorized.category === "config") {
    return {
      type: "fix",
      message: "Configuration error detected.",
      fixCommand: formatCliCommand("openclaw doctor"),
      docUrl: "https://docs.openclaw.ai/gateway/configuration",
    };
  }

  if (categorized.category === "permission") {
    return {
      type: "fix",
      message: "Permission error detected.",
      fixCommand: "chmod 755 ~/.openclaw",
      docUrl: "https://docs.openclaw.ai/gateway/troubleshooting",
    };
  }

  if (categorized.category === "port") {
    return {
      type: "skip",
      message: "Port conflict detected. You can configure a different port.",
      docUrl: "https://docs.openclaw.ai/gateway/configuration",
    };
  }

  return {
    type: "abort",
    message: `Unexpected error during ${step}`,
    docUrl: "https://docs.openclaw.ai/gateway/troubleshooting",
  };
}
