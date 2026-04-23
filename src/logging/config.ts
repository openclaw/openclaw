import { getCommandPathWithRootOptions } from "../cli/argv.js";
import type { LoggingConfig } from "../config/types.base.js";
import { readBestEffortLoggingConfig } from "./config-loader.js";

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

export function readLoggingConfig(): LoggingConfig | undefined {
  return shouldSkipMutatingLoggingConfigRead() ? undefined : readBestEffortLoggingConfig();
}
