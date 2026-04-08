import { fileURLToPath } from "node:url";
import { getCommandPathWithRootOptions } from "../cli/argv.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";

type LoggingConfig = OpenClawConfig["logging"];

const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const configModulePath = fileURLToPath(new URL("../config/config.js", import.meta.url));
type LoggingConfigLoader = () => LoggingConfig | undefined;
const loadLoggingConfigDefault: LoggingConfigLoader = () => {
  try {
    const loaded = requireConfig?.(configModulePath) as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    const logging = loaded?.loadConfig?.().logging;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return undefined;
    }
    return logging as LoggingConfig;
  } catch {
    return undefined;
  }
};
let loadLoggingConfig: LoggingConfigLoader = loadLoggingConfigDefault;

export function setLoggingConfigLoaderForTests(loader?: LoggingConfigLoader): void {
  loadLoggingConfig = loader ?? loadLoggingConfigDefault;
}

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

export function readLoggingConfig(): LoggingConfig | undefined {
  if (shouldSkipMutatingLoggingConfigRead()) {
    return undefined;
  }
  return loadLoggingConfig();
}
