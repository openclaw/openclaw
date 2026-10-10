import {
  asOptionalRecord,
  isRecord as hasRecord,
} from "@openclaw/normalization-core/record-coerce";
import {
  normalizeArrayBackedTrimmedStringList,
  normalizeTrimmedStringList,
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "../../../agents/agent-bundle-mcp-names.js";
import { listAgentEntriesWithSource } from "../../../agents/agent-scope-config.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../../agents/glob-pattern.js";
import { resolveProviderToolPolicy } from "../../../agents/provider-tool-policy.js";
import {
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
} from "../../../agents/tool-policy.js";
import type { AgentModelConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizePluginId } from "../../../plugins/config-state.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import { resolveDoctorPrimaryModelRef } from "./primary-model-ref.js";

type ToolAllowlistSource = {
  label: string;
  entries: string[];
};

type ActiveSandboxToolPolicy = ReturnType<typeof buildEffectiveSandboxToolPolicy>;

function normalizePluginIdMaybe(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? normalizePluginId(value) : undefined;
}

function collectToolPolicySources(policy: unknown, label: string, out: ToolAllowlistSource[]) {
  if (!hasRecord(policy)) {
    return;
  }
  for (const key of ["allow", "alsoAllow"] as const) {
    const entries = normalizeTrimmedStringList(policy[key]);
    if (entries.length > 0) {
      out.push({ label: `${label}.${key}`, entries });
    }
  }

  if (hasRecord(policy.byProvider)) {
    for (const [providerId, providerPolicy] of Object.entries(policy.byProvider)) {
      collectToolPolicySources(providerPolicy, `${label}.byProvider.${providerId}`, out);
    }
  }

  for (const key of ["sandbox", "subagents"] as const) {
    const tools = hasRecord(policy[key]) ? policy[key].tools : undefined;
    collectToolPolicySources(tools, `${label}.${key}.tools`, out);
  }
}

function collectToolAllowlistSources(cfg: OpenClawConfig): ToolAllowlistSource[] {
  const sources: ToolAllowlistSource[] = [];
  collectToolPolicySources(cfg.tools, "tools", sources);
  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    const label =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list[${source.index}]`;
    collectToolPolicySources(agent.tools, `${label}.tools`, sources);
  }
  return sources;
}

function formatSortedSourceLabels(sorted: readonly string[]): string {
  if (sorted.length <= 3) {
    return sorted.join(", ");
  }
  return `${sorted.slice(0, 3).join(", ")} (+${sorted.length - 3} more)`;
}

function formatSourceLabels(labels: Iterable<string>): string {
  return formatSortedSourceLabels(sortUniqueStrings(labels));
}

function formatSourceLabelSubject(labels: Iterable<string>): { text: string; verb: "does" | "do" } {
  const sorted = sortUniqueStrings(labels);
  return {
    text: formatSortedSourceLabels(sorted),
    verb: sorted.length === 1 ? "does" : "do",
  };
}

function collectToolOwners(registry: PluginManifestRegistry): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const plugin of registry.plugins) {
    const pluginId = normalizePluginId(plugin.id);
    for (const toolNameRaw of plugin.contracts?.tools ?? []) {
      const toolName = normalizeToolPolicyName(toolNameRaw);
      if (!toolName) {
        continue;
      }
      owners.set(toolName, [...(owners.get(toolName) ?? []), pluginId]);
    }
  }
  return owners;
}

function collectConfiguredMcpServerNames(cfg: OpenClawConfig): string[] {
  return Object.entries(asOptionalRecord(cfg.mcp?.servers) ?? {})
    .filter(([, value]) => hasRecord(value) && value.enabled !== false)
    .map(([name]) => name.trim())
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function isSandboxModeActive(mode: unknown): boolean {
  return mode === "all" || mode === "non-main";
}

function getList(value: unknown, key: "allow" | "alsoAllow" | "deny"): string[] | undefined {
  return hasRecord(value) ? normalizeArrayBackedTrimmedStringList(value[key]) : undefined;
}

function buildEffectiveSandboxToolPolicy(params: {
  agentPolicy?: unknown;
  agentLabel?: string;
  globalPolicy: unknown;
  nonSandboxToolPolicyBlocksMcp: boolean;
}) {
  const agentLabel = params.agentLabel ?? "agents.entries.*.tools.sandbox.tools";
  const policy: Record<string, unknown> = {};
  const fieldLabels: Partial<Record<"allow" | "alsoAllow" | "deny", string>> = {};
  for (const key of ["allow", "alsoAllow", "deny"] as const) {
    for (const [value, label] of [
      [params.agentPolicy, agentLabel],
      [params.globalPolicy, "tools.sandbox.tools"],
    ] as const) {
      if (hasRecord(value) && Array.isArray(value[key])) {
        policy[key] = value[key];
        fieldLabels[key] = `${label}.${key}`;
        break;
      }
    }
  }

  const allowLabels = [fieldLabels.allow, fieldLabels.alsoAllow].filter((label): label is string =>
    Boolean(label),
  );
  const labels = allowLabels.length > 0 ? allowLabels : ["tools.sandbox.tools.alsoAllow (unset)"];
  const dedupeLabels = uniqueStrings(
    [...labels, fieldLabels.deny].filter((label): label is string => Boolean(label)),
  );

  return {
    labels,
    dedupeKey: dedupeLabels.join("\u0000"),
    policy,
    nonSandboxToolPolicyBlocksMcp: params.nonSandboxToolPolicyBlocksMcp,
  };
}

function collectActiveSandboxToolPolicies(
  cfg: OpenClawConfig,
  serverNames: readonly string[],
): ActiveSandboxToolPolicy[] {
  const out = new Map<string, ActiveSandboxToolPolicy>();
  const globalPolicy = cfg.tools?.sandbox?.tools;
  const globalToolPolicyBlocksMcp = nonSandboxToolPoliciesBlockMcp({ cfg, serverNames });
  const addPolicy = (entry: ActiveSandboxToolPolicy) => {
    const existing = out.get(entry.dedupeKey);
    if (existing && !existing.nonSandboxToolPolicyBlocksMcp) {
      return;
    }
    out.set(entry.dedupeKey, entry);
  };

  const defaultSandboxActive = isSandboxModeActive(cfg.agents?.defaults?.sandbox?.mode);
  if (defaultSandboxActive) {
    addPolicy(
      buildEffectiveSandboxToolPolicy({
        globalPolicy,
        nonSandboxToolPolicyBlocksMcp: globalToolPolicyBlocksMcp,
      }),
    );
  }

  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    const agentSandbox = asOptionalRecord(agent.sandbox);
    const explicitMode = agentSandbox?.mode;
    const agentSandboxActive =
      explicitMode === undefined ? defaultSandboxActive : isSandboxModeActive(explicitMode);
    if (!agentSandboxActive) {
      continue;
    }
    const agentToolsSandbox = asOptionalRecord(asOptionalRecord(agent.tools)?.sandbox);
    const agentPolicy = asOptionalRecord(agentToolsSandbox?.tools);
    const label =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list[${source.index}]`;
    addPolicy(
      buildEffectiveSandboxToolPolicy({
        agentPolicy,
        agentLabel: `${label}.tools.sandbox.tools`,
        globalPolicy,
        nonSandboxToolPolicyBlocksMcp: nonSandboxToolPoliciesBlockMcp({
          cfg,
          serverNames,
          agent,
        }),
      }),
    );
  }

  return [...out.values()];
}

function buildMcpToolNamePrefixes(serverNames: readonly string[]): string[] {
  const usedNames = new Set<string>();
  return serverNames
    .map((serverName) =>
      normalizeToolPolicyName(`${sanitizeServerName(serverName, usedNames)}${TOOL_NAME_SEPARATOR}`),
    )
    .filter(Boolean);
}

function entriesMatchMcpTool(
  entries: readonly string[],
  serverNames: readonly string[],
  mode: "any" | "every",
): boolean {
  const normalizedEntries = entries.map(normalizeToolPolicyName).filter(Boolean);
  if (
    normalizedEntries.some(
      (entry) => entry === "*" || entry === "bundle-mcp" || entry === "group:plugins",
    )
  ) {
    return true;
  }
  const serverPrefixes = buildMcpToolNamePrefixes(serverNames);
  const patterns = compileGlobPatterns({
    raw: normalizedEntries,
    normalize: normalizeToolPolicyName,
  });
  const prefixOrPatternMatches = (prefix: string) =>
    normalizedEntries.some((entry) => entry.length > prefix.length && entry.startsWith(prefix)) ||
    matchesAnyGlobPattern(`${prefix}probe`, patterns);
  return mode === "every"
    ? serverPrefixes.every(prefixOrPatternMatches)
    : serverPrefixes.some(prefixOrPatternMatches);
}

function toolPolicyAllowsMcpServers(
  policy: unknown,
  serverNames: readonly string[],
  mode: "any" | "every",
  allowUnspecified = false,
): boolean {
  const allow = getList(policy, "allow");
  if (allow?.length === 0 || (allow === undefined && allowUnspecified)) {
    return true;
  }
  const entries = [...(allow ?? []), ...(getList(policy, "alsoAllow") ?? [])];
  return entriesMatchMcpTool(entries, serverNames, mode);
}

function toolPolicyDeniesAllMcpServers(policy: unknown, serverNames: readonly string[]): boolean {
  const deny = getList(policy, "deny") ?? [];
  return entriesMatchMcpTool(deny, serverNames, "every");
}

function nonSandboxToolPolicyBlocksMcp(policy: unknown, serverNames: readonly string[]): boolean {
  return (
    toolPolicyDeniesAllMcpServers(policy, serverNames) ||
    !toolPolicyAllowsMcpServers(policy, serverNames, "any", true)
  );
}

function profileToolPolicyBlocksMcp(policy: unknown, serverNames: readonly string[]): boolean {
  const profile = hasRecord(policy) && typeof policy.profile === "string" ? policy.profile : "";
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    getList(policy, "alsoAllow"),
  );
  return Boolean(profilePolicy && !toolPolicyAllowsMcpServers(profilePolicy, serverNames, "any"));
}

function nonSandboxToolPoliciesBlockMcp(params: {
  cfg: OpenClawConfig;
  serverNames: readonly string[];
  agent?: Record<string, unknown>;
}): boolean {
  const globalTools = params.cfg.tools;
  const agentTools = asOptionalRecord(params.agent?.tools);
  const modelRef = resolveDoctorPrimaryModelRef(
    params.cfg,
    params.agent?.model as AgentModelConfig,
  );
  const [globalProviderPolicy, agentProviderPolicy] = [
    globalTools?.byProvider,
    asOptionalRecord(agentTools?.byProvider),
  ].map((byProvider) =>
    resolveProviderToolPolicy({
      byProvider,
      modelProvider: modelRef.provider,
      modelId: modelRef.model,
    }),
  );
  const profilePolicy = {
    profile: agentTools?.profile ?? globalTools?.profile,
    alsoAllow: agentTools?.alsoAllow ?? globalTools?.alsoAllow,
  };
  const providerProfilePolicy = {
    profile: agentProviderPolicy?.profile ?? globalProviderPolicy?.profile,
    alsoAllow: agentProviderPolicy?.alsoAllow ?? globalProviderPolicy?.alsoAllow,
  };

  return (
    profileToolPolicyBlocksMcp(profilePolicy, params.serverNames) ||
    profileToolPolicyBlocksMcp(providerProfilePolicy, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(globalTools, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(globalProviderPolicy, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(agentTools, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(agentProviderPolicy, params.serverNames)
  );
}

function formatMcpServerSummary(serverNames: readonly string[]): string {
  const noun = serverNames.length === 1 ? "server" : "servers";
  const listed = serverNames
    .slice(0, 3)
    .map((serverName) => `"${serverName}"`)
    .join(", ");
  const suffix = serverNames.length > 3 ? `, +${serverNames.length - 3} more` : "";
  return `${serverNames.length} MCP ${noun}${listed ? ` (${listed}${suffix})` : ""}`;
}

function collectSandboxMcpAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const serverNames = collectConfiguredMcpServerNames(cfg);
  if (serverNames.length === 0) {
    return [];
  }
  const sandboxPolicies = collectActiveSandboxToolPolicies(cfg, serverNames);
  const issueSources = sandboxPolicies
    .filter(
      ({ policy }) =>
        !toolPolicyAllowsMcpServers(policy, serverNames, "every") &&
        !toolPolicyDeniesAllMcpServers(policy, serverNames),
    )
    .filter(
      ({ nonSandboxToolPolicyBlocksMcp: nonSandboxToolPolicyBlocksMcpLocal }) =>
        !nonSandboxToolPolicyBlocksMcpLocal,
    )
    .flatMap(({ labels }) => labels);
  if (issueSources.length === 0) {
    return [];
  }
  const sourceSubject = formatSourceLabelSubject(issueSources);
  return [
    `- mcp.servers defines ${formatMcpServerSummary(serverNames)}, but ${sourceSubject.text} ${sourceSubject.verb} not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>${TOOL_NAME_SEPARATOR}*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.`,
  ];
}

function formatPluginList(pluginIds: readonly string[]): string {
  return pluginIds.map((pluginId) => `"${pluginId}"`).join(", ");
}

function addIssue(issues: Map<string, Set<string>>, key: string, sourceLabel: string) {
  const sources = issues.get(key) ?? new Set<string>();
  sources.add(sourceLabel);
  issues.set(key, sources);
}

/** Collect warnings when plugin allowlists block tools referenced by active tool policies. */
export function collectPluginToolAllowlistWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  if (params.cfg.plugins?.enabled === false) {
    return [];
  }
  const warnings = collectSandboxMcpAllowlistWarnings(params.cfg);
  const allowedPluginIds = (params.cfg.plugins?.allow ?? [])
    .map(normalizePluginIdMaybe)
    .filter((pluginId): pluginId is string => Boolean(pluginId));
  const allowedPlugins = new Set(allowedPluginIds);
  if (allowedPlugins.size === 0) {
    return warnings;
  }

  const sources = collectToolAllowlistSources(params.cfg);
  if (sources.length === 0) {
    return warnings;
  }

  const wildcardSources = sources
    .filter((source) => source.entries.some((entry) => normalizeToolPolicyName(entry) === "*"))
    .map((source) => source.label);
  if (wildcardSources.length > 0) {
    warnings.push(
      `- plugins.allow is an exclusive plugin allowlist. ${formatSourceLabels(wildcardSources)} contains "*", but that wildcard only matches tools from plugins that are loaded; plugin tools outside plugins.allow stay unavailable. Add the required plugin ids to plugins.allow or remove plugins.allow.`,
    );
  }

  const exactEntries = sources.flatMap((source) =>
    source.entries
      .map((entry) => ({ source: source.label, entry: normalizeToolPolicyName(entry) }))
      .filter(({ entry }) => entry && entry !== "*" && entry !== "group:plugins"),
  );
  if (exactEntries.length === 0) {
    return warnings;
  }

  const registry =
    params.manifestRegistry ??
    loadManifestMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
    }).manifestRegistry;
  const knownPluginIds = new Set(registry.plugins.map((plugin) => normalizePluginId(plugin.id)));
  const toolOwners = collectToolOwners(registry);
  const missingPluginIssues = new Map<string, Set<string>>();
  const missingToolOwnerIssues = new Map<string, Set<string>>();

  for (const { source, entry } of exactEntries) {
    const pluginId = normalizePluginId(entry);
    if (knownPluginIds.has(pluginId) && !allowedPlugins.has(pluginId)) {
      addIssue(missingPluginIssues, pluginId, source);
      continue;
    }

    const owners = toolOwners.get(entry) ?? [];
    if (owners.length > 0 && owners.every((ownerPluginId) => !allowedPlugins.has(ownerPluginId))) {
      addIssue(missingToolOwnerIssues, `${entry}\u0000${owners.join("\u0000")}`, source);
    }
  }

  for (const [pluginId, issueSources] of [...missingPluginIssues.entries()].toSorted(
    (left, right) => left[0].localeCompare(right[0]),
  )) {
    warnings.push(
      `- ${formatSourceLabels(issueSources)} references plugin "${pluginId}", but plugins.allow does not include it. Add "${pluginId}" to plugins.allow or remove plugins.allow.`,
    );
  }

  for (const [issueKey, issueSources] of [...missingToolOwnerIssues.entries()].toSorted(
    (left, right) => left[0].localeCompare(right[0]),
  )) {
    const [toolName, ...ownerPluginIds] = issueKey.split("\u0000");
    if (!toolName) {
      continue;
    }
    warnings.push(
      `- ${formatSourceLabels(issueSources)} references tool "${toolName}", owned by plugin ${formatPluginList(ownerPluginIds)}, but plugins.allow does not include the owning plugin. Add ${formatPluginList(ownerPluginIds)} to plugins.allow or remove plugins.allow.`,
    );
  }

  return warnings;
}
