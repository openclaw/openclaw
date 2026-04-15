import { getCommandPathWithRootOptions } from "../cli/argv.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";

type LoggingConfig = OpenClawConfig["logging"];
type LoggingConfigLoader = () => LoggingConfig | undefined;

const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
let registeredLoggingConfigLoader: LoggingConfigLoader | null = null;

function coerceLoggingConfig(logging: unknown): LoggingConfig | undefined {
  if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
    return undefined;
  }
  return logging as LoggingConfig;
}

export function registerLoggingConfigLoader(loader?: LoggingConfigLoader): void {
  registeredLoggingConfigLoader = loader ?? null;
}

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

export function readLoggingConfig(): LoggingConfig | undefined {
  if (shouldSkipMutatingLoggingConfigRead()) {
    return undefined;
  }
  if (registeredLoggingConfigLoader) {
    try {
      return coerceLoggingConfig(registeredLoggingConfigLoader());
    } catch {
      return undefined;
    }
  }
  try {
    const loaded = requireConfig?.("../config/config.js") as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    return coerceLoggingConfig(loaded?.loadConfig?.().logging);
  } catch {
    return undefined;
  }
}
