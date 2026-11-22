/**
 * Manifest-level pre-load filtering for the ACPX `openclaw-plugin-tools` MCP
 * bridge. Evaluates both the owning agent's base policy (including optional
 * plugin tool grants) and the bridge filter against declared manifest tools so
 * excluded plugins are skipped before module loading without ever passing the
 * bridge allowlist as an optional-tool grant.
 */
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import {
  applyToolPolicyPipeline,
  type ToolPolicyPipelineStep,
} from "../agents/tool-policy-pipeline.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyTestPluginDefaults } from "../plugins/config-state.js";
import { loadManifestContractSnapshot } from "../plugins/manifest-contract-eligibility.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";

function matchesDenylist(value: string, denylist: ReturnType<typeof compileGlobPatterns>): boolean {
  const normalized = normalizeToolPolicyName(value);
  return normalized ? matchesAnyGlobPattern(normalized, denylist) : false;
}

/**
 * Return manifest plugin IDs whose declared tools are completely eliminated by
 * the combined base + bridge tool policy pipeline (including base optional-tool
 * gating). Adding these IDs to `toolDenylist` prevents `acquireStandalonePluginToolRegistry`
 * from importing excluded plugin modules while keeping `toolAllowlist` strictly
 * owned by the base policy.
 */
export function resolveBridgeExcludedPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  baseAllowlist: string[];
  baseDenylist: string[];
  steps: ToolPolicyPipelineStep[];
}): string[] {
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.config ?? {}, env);
  const loadContext = resolvePluginRuntimeLoadContext({
    config: baseConfig,
    env,
    workspaceDir: params.workspaceDir,
  });
  if (loadContext.config.plugins?.enabled === false) {
    return [];
  }
  const snapshot = loadManifestContractSnapshot({
    config: loadContext.config,
    workspaceDir: loadContext.workspaceDir,
    env,
  });
  const baseAllowlist = createPluginToolAllowlist(params.baseAllowlist);
  const baseDenylist = compileGlobPatterns({
    raw: params.baseDenylist,
    normalize: normalizeToolPolicyName,
  });
  const denyAllPlugins = matchesAnyGlobPattern("group:plugins", baseDenylist);
  const excluded: string[] = [];
  for (const plugin of snapshot.plugins) {
    const declaredTools = plugin.contracts?.tools ?? [];
    if (declaredTools.length === 0) {
      continue;
    }
    if (denyAllPlugins || matchesDenylist(plugin.id, baseDenylist)) {
      excluded.push(plugin.id);
      continue;
    }
    const baseAllowsPlugin = baseAllowlist.allowsPlugin(plugin.id);
    const baseEligible = declaredTools
      .filter((name) => {
        if (matchesDenylist(name, baseDenylist)) {
          return false;
        }
        const isOptional = plugin.toolMetadata?.[name]?.optional === true;
        if (isOptional) {
          return baseAllowlist.allowsTool(plugin.id, name);
        }
        return (
          baseAllowsPlugin ||
          baseAllowlist.includesDefaults ||
          baseAllowlist.allowsTool(plugin.id, name)
        );
      })
      .map((name) => ({ name }));
    if (baseEligible.length === 0) {
      excluded.push(plugin.id);
      continue;
    }
    const surviving = applyToolPolicyPipeline({
      tools: baseEligible,
      toolMeta: () => ({ pluginId: plugin.id }),
      warn: () => {},
      steps: params.steps,
    });
    if (surviving.length === 0) {
      excluded.push(plugin.id);
    }
  }
  return excluded;
}
