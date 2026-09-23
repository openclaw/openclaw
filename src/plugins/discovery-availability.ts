import type fs from "node:fs";
import {
  extractErrorCode,
  formatErrorMessageWithCode,
  isMissingPathError,
} from "../infra/errors.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  pluginCacheExistsSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
} from "./plugin-cache-files.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { PLUGIN_AVAILABILITY_POLICY } from "./runtime-degraded-state.js";

const CONFIGURED_PLUGIN_PATH_UNAVAILABLE = "configured-plugin-path-unavailable";
const CONFIGURED_PLUGIN_PATH_INSPECTION_FAILED = "configured-plugin-path-inspection-failed";

export function isConfiguredPluginPathDiagnosticCode(code: unknown) {
  return (
    code === CONFIGURED_PLUGIN_PATH_UNAVAILABLE || code === CONFIGURED_PLUGIN_PATH_INSPECTION_FAILED
  );
}

export function pluginPathFailureDiagnostic(
  source: string,
  origin: PluginOrigin,
  error: unknown,
): PluginDiagnostic {
  if (origin === "config" && !isMissingPathError(error)) {
    const errorCode = extractErrorCode(error) ?? "UNKNOWN";
    const recovery =
      errorCode === "EACCES" || errorCode === "EPERM"
        ? `Fix permissions on ${source}`
        : errorCode === "ELOOP"
          ? `Fix the symbolic link loop at ${source}`
          : `Resolve the filesystem inspection error on ${source}`;
    const fixHint = `${recovery}, then run \`${PLUGIN_AVAILABILITY_POLICY.repairCommand}\`.`;
    return {
      level: "warn",
      code: CONFIGURED_PLUGIN_PATH_INSPECTION_FAILED,
      configDisposition: "preserve",
      errorCode,
      source,
      fixHint,
      message: `Configured plugin load path inspection failed: ${source} (${formatErrorMessageWithCode(error)}). Uninspected plugin configuration is preserved. ${fixHint}`,
    };
  }
  return origin === "config"
    ? {
        level: "warn",
        code: CONFIGURED_PLUGIN_PATH_UNAVAILABLE,
        configDisposition: "preserve",
        source,
        message: `Configured plugin load path is unavailable: ${source}. Uninspected plugin configuration is preserved. Restore access to the path, then run \`${PLUGIN_AVAILABILITY_POLICY.repairCommand}\`.`,
      }
    : { level: "error", source, message: `plugin path not found: ${source}` };
}

export function inspectPluginLoadPath(
  source: string,
  origin: PluginOrigin,
  diagnostics: PluginDiagnostic[],
): fs.Stats | null {
  try {
    const stat = pluginCacheStatSync(source, origin === "config");
    if (!stat && !pluginCacheExistsSync(source)) {
      diagnostics.push(pluginPathFailureDiagnostic(source, origin, undefined));
    }
    // Inspect selected directories before bundled provenance can replace their config origin.
    if (origin === "config" && stat) {
      if (stat.isDirectory()) {
        readPluginCacheDirectory(source);
      } else if (!stat.isFile()) {
        throw Object.assign(new Error("Plugin load path is not a regular file or directory"), {
          code: "ERR_INVALID_FILE_TYPE",
        });
      }
    }
    return stat;
  } catch (error) {
    diagnostics.push(pluginPathFailureDiagnostic(source, origin, error));
    return null;
  }
}

/** Consumers consult discovery's disposition without reclassifying availability. */
export function findUninspectedPluginDiagnostic(diagnostics: readonly PluginDiagnostic[]) {
  return diagnostics.find((diagnostic) => diagnostic.configDisposition === "preserve");
}

/** Project the recorded fact onto a config surface whose owner could not be inspected. */
export function pluginDiagnosticToConfigWarning(diagnostic: PluginDiagnostic, path: string) {
  return {
    path,
    message: diagnostic.message,
    code: diagnostic.code,
    source: diagnostic.source,
    ...(diagnostic.errorCode ? { errorCode: diagnostic.errorCode } : {}),
    ...(diagnostic.fixHint ? { fixHint: diagnostic.fixHint } : {}),
  };
}

/** Missing metadata cannot prove that authored plugin configuration is stale. */
export function hasIncompletePluginDiscovery(diagnostics: readonly PluginDiagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => diagnostic.level === "error" || diagnostic.configDisposition === "preserve",
  );
}
