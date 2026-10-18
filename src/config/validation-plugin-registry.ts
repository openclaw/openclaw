import { normalizePluginId } from "../plugins/config-state.js";
import { pluginDiagnosticToConfigWarning } from "../plugins/discovery-availability.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveSecretRefProviderSourceMismatch } from "../secrets/ref-contract.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import { isRecord } from "../utils.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { resolveSecretInputRef } from "./types.secrets.js";
import { withConfigIssuePath } from "./validation-issues.js";

function collectExplicitPluginReferencePaths(raw: unknown): Map<string, string | undefined> {
  const references = new Map<string, string | undefined>();
  if (!isRecord(raw) || !isRecord(raw.plugins)) {
    return references;
  }
  const { plugins } = raw;
  // Later sources win: entries > allow > deny > the last matching slot.
  if (isRecord(plugins.slots)) {
    for (const [slotId, pluginId] of Object.entries(plugins.slots)) {
      if (typeof pluginId !== "string") {
        continue;
      }
      const normalized = normalizePluginId(pluginId);
      if (normalized && normalized !== "none") {
        references.set(normalized, slotId ? `plugins.slots.${slotId}` : undefined);
      }
    }
  }
  for (const key of ["deny", "allow"] as const) {
    const value = plugins[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        const normalized = normalizePluginId(entry);
        if (normalized) {
          references.set(normalized, `plugins.${key}`);
        }
      }
    }
  }
  if (isRecord(plugins.entries)) {
    for (const pluginId of Object.keys(plugins.entries)) {
      const normalized = normalizePluginId(pluginId);
      if (normalized) {
        references.set(normalized, `plugins.entries.${normalized}`);
      }
    }
  }
  return references;
}

/** Classify one registry generation against its authored plugin references and deferred owners. */
export function createPluginRegistryConfigValidator(params: {
  raw: unknown;
  deferredPluginIds: ReadonlySet<string>;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
}): (registry: PluginManifestRegistry) => void {
  const references = collectExplicitPluginReferencePaths(params.raw);
  let checked = false;
  return (registry) => {
    if (checked) {
      return;
    }
    checked = true;
    for (const diagnostic of registry.diagnostics) {
      if (diagnostic.level === "info") {
        continue;
      }
      if (diagnostic.configDisposition === "preserve") {
        params.warnings.push(pluginDiagnosticToConfigWarning(diagnostic, "plugins.load.paths"));
        continue;
      }
      const explicitPath = diagnostic.pluginId
        ? references.get(normalizePluginId(diagnostic.pluginId))
        : undefined;
      const issuePath =
        !diagnostic.pluginId && diagnostic.message.includes("plugin path not found")
          ? "plugins.load.paths"
          : (explicitPath ?? "plugins");
      const pluginLabel = diagnostic.pluginId ? `plugin ${diagnostic.pluginId}` : "plugin";
      const issue = { path: issuePath, message: `${pluginLabel}: ${diagnostic.message}` };
      const deferred =
        diagnostic.pluginId && params.deferredPluginIds.has(normalizePluginId(diagnostic.pluginId));
      (diagnostic.level === "error" && (explicitPath || !diagnostic.pluginId) && !deferred
        ? params.issues
        : params.warnings
      ).push(issue);
    }
  };
}

export function collectSecretRefProviderSourceIssues(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
}): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const target of discoverConfigSecretTargets(params.config, {
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  })) {
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults: params.config.secrets?.defaults,
    });
    if (!ref) {
      continue;
    }
    const configuredSource = resolveSecretRefProviderSourceMismatch(params.config, ref);
    if (!configuredSource) {
      continue;
    }
    const path = target.refPath ?? target.path;
    const pathSegments = target.refPathSegments ?? target.pathSegments;
    issues.push(
      withConfigIssuePath(
        {
          path,
          message: `Secret provider "${ref.provider}" has source "${configuredSource}" but ref requests "${ref.source}".`,
        },
        pathSegments,
      ),
    );
  }
  return issues;
}
