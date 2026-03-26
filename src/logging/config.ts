import { getCommandPathWithRootOptions } from "../cli/argv.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { loggingState } from "./state.js";

type LoggingConfig = OpenClawConfig["logging"];

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

export function readLoggingConfig(): LoggingConfig | undefined {
  if (shouldSkipMutatingLoggingConfigRead()) {
    return undefined;
  }
  // Guard: prevent re-entrancy when loadConfig() triggers patched console.* calls.
  // The guard flag is also set in resolveConsoleSettings(); this is a secondary guard.
  if (loggingState.resolvingConsoleSettings) {
    return undefined;
  }
  try {
    const parsed = loadConfig();
    const logging = parsed?.logging;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return undefined;
    }
    return logging as LoggingConfig;
  } catch {
    return undefined;
  }
}
