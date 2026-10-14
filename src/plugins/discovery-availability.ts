import type fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  extractErrorCode,
  formatErrorMessageWithCode,
  isMissingPathError,
} from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginId } from "./config-state.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { resolvePackagePluginApiRange, satisfiesPluginApiRange } from "./package-compat.js";
import {
  pluginCacheExistsSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
} from "./plugin-cache-files.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { PLUGIN_AVAILABILITY_POLICY } from "./runtime-degraded-state.js";

const CONFIGURED_PLUGIN_PATH_UNAVAILABLE = "configured-plugin-path-unavailable";
const CONFIGURED_PLUGIN_PATH_INSPECTION_FAILED = "configured-plugin-path-inspection-failed";

export function shouldSkipIncompatiblePackagePluginApi(params: {
  origin: PluginOrigin;
  packageManifest: OpenClawPackageManifest | undefined;
  pluginId: string;
  packageDir: string;
  env: NodeJS.ProcessEnv;
  diagnostics: PluginDiagnostic[];
}): boolean {
  if (params.origin === "bundled") {
    return false;
  }
  const packagePluginApiRangeCheck = resolvePackagePluginApiRange(params.packageManifest);
  if (!packagePluginApiRangeCheck.ok) {
    params.diagnostics.push({
      level: "warn",
      configDisposition: "preserve",
      source: path.join(params.packageDir, "package.json"),
      message: `invalid package plugin API metadata: ${packagePluginApiRangeCheck.error}; skipping discovery (check package.json openclaw.compat.pluginApi)`,
      pluginId: params.pluginId,
    });
    return true;
  }
  const packagePluginApiRange = packagePluginApiRangeCheck.range;
  if (!packagePluginApiRange) {
    return false;
  }
  const compatibilityHostVersion = resolveCompatibilityHostVersion(params.env);
  if (satisfiesPluginApiRange(compatibilityHostVersion, packagePluginApiRange)) {
    return false;
  }
  params.diagnostics.push({
    level: "warn",
    configDisposition: "preserve",
    source: path.join(params.packageDir, "package.json"),
    message: `plugin requires plugin API ${packagePluginApiRange}, but this host is ${compatibilityHostVersion}; skipping discovery (check "openclaw --version", OPENCLAW_COMPATIBILITY_HOST_VERSION, or run "openclaw doctor")`,
    pluginId: params.pluginId,
  });
  return true;
}

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
export function pluginDiagnosticToConfigWarning(diagnostic: PluginDiagnostic, configPath: string) {
  return {
    path: configPath,
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

/** Blocked candidates are present, not stale. Explicit identity excludes path-name guesses. */
export function createBlockedPluginDiagnosticLookup(params: {
  diagnostics: readonly PluginDiagnostic[];
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const BLOCKED_PLUGIN_CANDIDATE_PREFIX = "blocked plugin candidate:";
  const blockedPluginDiagnostics = new Map<string, { message: string; source?: string }>();
  const blockedPluginDiagnosticsWithSource: Array<{ message: string; source: string }> = [];
  const normalizeBlockedDiagnosticPath = (value: string | undefined): string => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return path.resolve(resolveUserPath(trimmed, params.env ?? process.env));
    } catch {
      return path.resolve(trimmed);
    }
  };
  for (const diag of params.diagnostics) {
    if (!diag.message.startsWith(BLOCKED_PLUGIN_CANDIDATE_PREFIX)) {
      continue;
    }
    if (!diag.pluginId && diag.source) {
      blockedPluginDiagnosticsWithSource.push({ message: diag.message, source: diag.source });
    }
    if (diag.pluginId) {
      const normalizedPluginId = normalizePluginId(diag.pluginId);
      for (const key of [diag.pluginId, normalizedPluginId]) {
        if (key && !blockedPluginDiagnostics.has(key)) {
          blockedPluginDiagnostics.set(key, {
            message: diag.message,
            ...(diag.source ? { source: diag.source } : {}),
          });
        }
      }
    }
  }
  const blockedDiagnosticSourceMatchesPluginId = (
    diagnostic: { message: string; source: string },
    pluginId: string,
  ): boolean => {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return false;
    }
    const sourcePath = normalizeBlockedDiagnosticPath(diagnostic.source);
    if (!sourcePath) {
      return false;
    }
    if (
      normalizePluginId(path.basename(sourcePath)) === normalizedPluginId ||
      normalizePluginId(path.basename(path.dirname(sourcePath))) === normalizedPluginId
    ) {
      return true;
    }
    for (const loadPath of params.config?.plugins?.load?.paths ?? []) {
      const resolvedLoadPath = normalizeBlockedDiagnosticPath(loadPath);
      if (
        resolvedLoadPath &&
        normalizePluginId(path.basename(resolvedLoadPath)) === normalizedPluginId &&
        (isPathInside(resolvedLoadPath, sourcePath) || isPathInside(sourcePath, resolvedLoadPath))
      ) {
        return true;
      }
    }
    return false;
  };
  return (pluginId: string) =>
    blockedPluginDiagnostics.get(pluginId) ??
    blockedPluginDiagnostics.get(normalizePluginId(pluginId)) ??
    blockedPluginDiagnosticsWithSource.find((diagnostic) =>
      blockedDiagnosticSourceMatchesPluginId(diagnostic, pluginId),
    );
}
