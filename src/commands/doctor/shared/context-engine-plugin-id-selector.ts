import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveAgentWorkspaceDir, tryResolveDefaultAgentId } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  normalizePluginId,
  normalizePluginsConfig,
  resolveSelectedContextEnginePluginId,
} from "../../../plugins/config-state.js";
import { hasIncompletePluginDiscovery } from "../../../plugins/discovery-availability.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import { normalizePluginPolicyId } from "../../../plugins/plugin-policy-id.js";
import { defaultSlotIdForKey, hasKind } from "../../../plugins/slots.js";

const SLOT_PATH = "plugins.slots.contextEngine";

type SelectorFinding =
  | { kind: "replace"; selector: string; pluginId: string; engineId: string }
  | { kind: "choose"; message: string };

/**
 * Before declared engine ownership, installing a context-engine plugin stored its plugin ID
 * as the selector. Such a selector never resolves when the plugin registers a different
 * engine ID, so turns silently fall back to legacy. Only the plugin's single declared,
 * eligible engine replaces it; ambiguous or unauthorized owners stay unchanged.
 */
export function findContextEnginePluginIdSelector(
  cfg: OpenClawConfig,
  plugins: readonly PluginManifestRecord[],
): SelectorFinding | undefined {
  const selector = cfg.plugins?.slots?.contextEngine?.trim();
  if (
    cfg.plugins?.enabled === false ||
    !selector ||
    selector.toLowerCase() === "none" ||
    selector === defaultSlotIdForKey("contextEngine") ||
    // A declared engine ID is already a valid selector, whatever its owner is named.
    plugins.some((plugin) => plugin.contextEngineIds?.includes(selector))
  ) {
    return undefined;
  }
  const owner = plugins.find(
    (plugin) =>
      hasKind(plugin.kind, "context-engine") &&
      plugin.contextEngineIds?.length &&
      normalizePluginPolicyId(plugin.id) === normalizePluginPolicyId(selector),
  );
  const engineIds = owner?.contextEngineIds ?? [];
  if (!owner || engineIds.length === 0) {
    return undefined;
  }
  const [engineId] = engineIds;
  if (engineIds.length !== 1 || !engineId) {
    return {
      kind: "choose",
      message: `- ${SLOT_PATH}: "${selector}" is a plugin ID, not an engine ID. Plugin "${owner.id}" declares multiple engines; set ${SLOT_PATH} to one of: ${engineIds.join(", ")}.`,
    };
  }
  const records = plugins.map(({ id, contextEngineIds }) => ({ id, contextEngineIds }));
  if (
    !isIndependentlyApproved(cfg, owner.id) ||
    resolveSelectedContextEnginePluginId(withSelector(cfg, engineId), records) !== owner.id
  ) {
    return {
      kind: "choose",
      message: `- ${SLOT_PATH}: "${selector}" is a plugin ID, not an engine ID. Plugin "${owner.id}" declares engine "${engineId}", but it is not independently enabled or another eligible plugin declares the same engine. Enable plugins.entries.${owner.id} or resolve the conflict, then set ${SLOT_PATH} to "${engineId}".`,
    };
  }
  return { kind: "replace", selector, pluginId: owner.id, engineId };
}

/**
 * The resolver lets an explicit equal-ID selection bypass enablement and the allowlist.
 * Doctor did not receive that selection, so it never widens activation on its own.
 */
function isIndependentlyApproved(cfg: OpenClawConfig, pluginId: string): boolean {
  const policy = normalizePluginsConfig(cfg.plugins);
  const key = normalizePluginPolicyId(normalizePluginId(pluginId));
  return (
    (policy.entries[key]?.enabled === true || policy.allow.includes(key)) &&
    (policy.allow.length === 0 || policy.allow.includes(key))
  );
}

function withSelector(cfg: OpenClawConfig, engineId: string): OpenClawConfig {
  return {
    ...cfg,
    plugins: { ...cfg.plugins, slots: { ...cfg.plugins?.slots, contextEngine: engineId } },
  };
}

function loadSelectorFinding(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): SelectorFinding | undefined {
  if (!cfg.plugins?.slots?.contextEngine || cfg.plugins.enabled === false) {
    return undefined;
  }
  const agentId = tryResolveDefaultAgentId(cfg);
  const registry = loadManifestMetadataSnapshot({
    config: cfg,
    workspaceDir: agentId ? resolveAgentWorkspaceDir(cfg, agentId) : undefined,
    env: env ?? process.env,
  }).manifestRegistry;
  // Incomplete discovery cannot prove which plugin declares the selected ID.
  return hasIncompletePluginDiscovery(registry.diagnostics)
    ? undefined
    : findContextEnginePluginIdSelector(cfg, registry.plugins);
}

/** Doctor repair: replace a legacy plugin-ID context-engine selector with its declared engine. */
export function maybeRepairContextEnginePluginIdSelector(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  const finding = loadSelectorFinding(cfg, env);
  if (!finding) {
    return { config: cfg, changes: [] };
  }
  if (finding.kind === "choose") {
    return { config: cfg, changes: [], warnings: [sanitizeForLog(finding.message)] };
  }
  return {
    config: withSelector(cfg, finding.engineId),
    changes: [
      sanitizeForLog(
        `- ${SLOT_PATH}: replaced plugin ID "${finding.selector}" with its declared engine "${finding.engineId}"`,
      ),
    ],
  };
}

/** Doctor preview: describe the selector repair without changing config. */
export function collectContextEnginePluginIdSelectorWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const finding = loadSelectorFinding(params.cfg, params.env);
  if (!finding) {
    return [];
  }
  return [
    sanitizeForLog(
      finding.kind === "choose"
        ? finding.message
        : `- ${SLOT_PATH}: "${finding.selector}" is plugin "${finding.pluginId}"'s ID, so its engine never loads and turns fall back to legacy. Run "${params.doctorFixCommand}" to select its declared engine "${finding.engineId}".`,
    ),
  ];
}
