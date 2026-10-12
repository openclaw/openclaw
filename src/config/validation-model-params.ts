import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { listAgentEntriesWithSource } from "../agents/agent-scope.js";
import { normalizePluginId } from "../plugins/config-state.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { collectPluginProviderRequestOwners } from "../plugins/plugin-provider-request-policy.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import {
  validatePreparedPluginSchemaValue,
  type PreparedPluginSchemaValidations,
} from "./validation-prepared.js";

/** Validate authored per-model params without filling defaults into override layers. */
export function validateProviderModelParams(params: {
  config: OpenClawConfig;
  registry: PluginManifestRegistry;
  deferredPluginIds: ReadonlySet<string>;
  schemaValidations?: PreparedPluginSchemaValidations;
}): ConfigValidationIssue[] {
  const scopes = [
    { path: "agents.defaults", models: params.config.agents?.defaults?.models },
    ...listAgentEntriesWithSource(params.config).map(({ entry, source }) => ({
      path:
        source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`,
      models: entry.models,
    })),
  ];
  const issues: ConfigValidationIssue[] = [];
  const requestOwners = collectPluginProviderRequestOwners(params.registry.plugins);
  for (const [provider, { plugin, policy }] of requestOwners) {
    if (!policy.modelParamsSchema || params.deferredPluginIds.has(normalizePluginId(plugin.id))) {
      continue;
    }
    for (const scope of scopes) {
      for (const [ref, entry] of Object.entries(scope.models ?? {})) {
        if (!entry.params || parseProviderModelRef(ref)?.provider !== provider) {
          continue;
        }
        const base = `${scope.path}.models.${ref}.params`;
        const result = validatePreparedPluginSchemaValue(
          {
            origin: plugin.origin,
            schema: policy.modelParamsSchema,
            cacheKey: `model-params:${plugin.id}:${base}`,
            value: entry.params,
            applyDefaults: false,
          },
          params.schemaValidations,
        );
        if (!result.ok) {
          issues.push(
            ...result.errors.map((error) => ({
              path: error.path === "<root>" ? base : `${base}.${error.path}`,
              message: `invalid model params: ${error.message}`,
              allowedValues: error.allowedValues,
              allowedValuesHiddenCount: error.allowedValuesHiddenCount,
            })),
          );
        }
      }
    }
  }
  return issues;
}
