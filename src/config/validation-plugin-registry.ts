import { normalizePluginId } from "../plugins/config-state.js";
import { pluginDiagnosticToConfigWarning } from "../plugins/discovery-availability.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveSecretRefProviderSourceMismatch } from "../secrets/ref-contract.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import { isRecord } from "../utils.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { resolveSecretInputRef } from "./types.secrets.js";
import { withConfigIssuePath } from "./validation-issues.js";

type ExplicitPluginReferences = {
  entries: Set<string>;
  allow: Set<string>;
  deny: Set<string>;
  slots: Map<string, string>;
};

function collectExplicitPluginReferences(raw: unknown): ExplicitPluginReferences {
  const references: ExplicitPluginReferences = {
    entries: new Set(),
    allow: new Set(),
    deny: new Set(),
    slots: new Map(),
  };
  if (!isRecord(raw) || !isRecord(raw.plugins)) {
    return references;
  }
  const { plugins } = raw;
  if (isRecord(plugins.entries)) {
    for (const pluginId of Object.keys(plugins.entries)) {
      const normalized = normalizePluginId(pluginId);
      if (normalized) {
        references.entries.add(normalized);
      }
    }
  }
  for (const [key, target] of [
    ["allow", references.allow],
    ["deny", references.deny],
  ] as const) {
    const value = plugins[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        const normalized = normalizePluginId(entry);
        if (normalized) {
          target.add(normalized);
        }
      }
    }
  }
  if (isRecord(plugins.slots)) {
    for (const [slotId, pluginId] of Object.entries(plugins.slots)) {
      if (typeof pluginId !== "string") {
        continue;
      }
      const normalized = normalizePluginId(pluginId);
      if (normalized && normalized !== "none") {
        references.slots.set(normalized, slotId);
      }
    }
  }
  return references;
}

function resolveExplicitPluginReferencePath(
  references: ExplicitPluginReferences,
  pluginId: string,
): string | undefined {
  const normalized = normalizePluginId(pluginId);
  if (!normalized) {
    return undefined;
  }
  if (references.entries.has(normalized)) {
    return `plugins.entries.${normalized}`;
  }
  if (references.allow.has(normalized)) {
    return "plugins.allow";
  }
  if (references.deny.has(normalized)) {
    return "plugins.deny";
  }
  const slotId = references.slots.get(normalized);
  return slotId ? `plugins.slots.${slotId}` : undefined;
}

/** Classify one registry generation against its authored plugin references and deferred owners. */
export function createPluginRegistryConfigValidator(params: {
  raw: unknown;
  deferredPluginIds: ReadonlySet<string>;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
}): (registry: PluginManifestRegistry) => void {
  const references = collectExplicitPluginReferences(params.raw);
  let checked = false;
  return (registry) => {
    if (checked) {
      return;
    }
    checked = true;
    for (const diagnostic of registry.diagnostics) {
      if (diagnostic.configDisposition === "preserve") {
        params.warnings.push(pluginDiagnosticToConfigWarning(diagnostic, "plugins.load.paths"));
        continue;
      }
      const explicitPath = diagnostic.pluginId
        ? resolveExplicitPluginReferencePath(references, diagnostic.pluginId)
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
