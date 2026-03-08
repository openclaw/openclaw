import type { OpenClawConfig } from "../config/config.js";
import { loadRepoOwnershipForRuntime, matchRepoOwnershipPath } from "../plugins/path-safety.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { logSreMetric } from "../sre/observability/log.js";
import { resolvePathFromInput } from "./path-policy.js";
import {
  expandToolGroups,
  normalizeToolList,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy-shared.js";
import type { AnyAgentTool } from "./tools/common.js";
export {
  expandToolGroups,
  normalizeToolList,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy-shared.js";
export type { ToolProfileId } from "./tool-policy-shared.js";

// Keep tool-policy browser-safe: do not import tools/common at runtime.
function wrapOwnerOnlyToolExecution(tool: AnyAgentTool, senderIsOwner: boolean): AnyAgentTool {
  if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) {
    return tool;
  }
  return {
    ...tool,
    execute: async () => {
      throw new Error("Tool restricted to owner senders.");
    },
  };
}

const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set<string>(["whatsapp_login", "cron", "gateway"]);

export function isOwnerOnlyToolName(name: string) {
  return OWNER_ONLY_TOOL_NAME_FALLBACKS.has(normalizeToolName(name));
}

function isOwnerOnlyTool(tool: AnyAgentTool) {
  return tool.ownerOnly === true || isOwnerOnlyToolName(tool.name);
}

export function applyOwnerOnlyToolPolicy(tools: AnyAgentTool[], senderIsOwner: boolean) {
  const withGuard = tools.map((tool) => {
    if (!isOwnerOnlyTool(tool)) {
      return tool;
    }
    return wrapOwnerOnlyToolExecution(tool, senderIsOwner);
  });
  if (senderIsOwner) {
    return withGuard;
  }
  return withGuard.filter((tool) => !isOwnerOnlyTool(tool));
}

export type SreAgentExecutionRole = "fixer" | "investigator" | "verifier";

const SRE_FIXER_AGENT_IDS = new Set(["sre-repo-runtime", "sre-repo-helm"]);
const SRE_VERIFIER_AGENT_IDS = new Set(["sre-verifier"]);
const SRE_FIXER_REPO_ALLOWLIST: Record<string, string[]> = {
  "sre-repo-runtime": ["openclaw-sre"],
  "sre-repo-helm": ["morpho-infra-helm"],
};

function isMutatingExecCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /(^|[|&;]\s*)(cp|mv|rm|mkdir|touch|tee|patch)\b/.test(normalized) ||
    /\bsed\s+-i\b/.test(normalized) ||
    /\bperl\s+-i\b/.test(normalized) ||
    /\bgit\s+(apply|checkout|switch|cherry-pick|commit|add|rm|mv|rebase|merge|reset)\b/.test(
      normalized,
    ) ||
    />{1,2}/.test(normalized)
  );
}

function extractMutatingToolPaths(toolName: string, params: Record<string, unknown>): string[] {
  const normalizedTool = normalizeToolName(toolName);
  if (normalizedTool === "write" || normalizedTool === "edit") {
    return typeof params.path === "string" ? [params.path] : [];
  }
  if (normalizedTool === "apply_patch") {
    const input = typeof params.input === "string" ? params.input : "";
    return input
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        for (const prefix of [
          "*** Add File: ",
          "*** Delete File: ",
          "*** Update File: ",
          "*** Move to: ",
        ]) {
          if (line.startsWith(prefix)) {
            return [line.slice(prefix.length).trim()];
          }
        }
        return [];
      })
      .filter(Boolean);
  }
  return [];
}

function resolveAllowedFixerRepos(agentId: string): string[] {
  return SRE_FIXER_REPO_ALLOWLIST[agentId] ?? [];
}

export function resolveSreAgentExecutionRole(
  _config: OpenClawConfig | undefined,
  agentId: string | undefined,
): SreAgentExecutionRole | undefined {
  const normalized = normalizeAgentId(agentId ?? "");
  if (!normalized) {
    return undefined;
  }
  if (SRE_FIXER_AGENT_IDS.has(normalized)) {
    return "fixer";
  }
  if (SRE_VERIFIER_AGENT_IDS.has(normalized)) {
    return "verifier";
  }
  if (normalized.startsWith("sre")) {
    return "investigator";
  }
  return undefined;
}

async function assertOwnedMutationTargets(params: {
  agentId: string;
  config?: OpenClawConfig;
  workspaceRoot: string;
  toolName: string;
  toolParams: Record<string, unknown>;
}) {
  const ownership = await loadRepoOwnershipForRuntime({ config: params.config });
  const allowedRepos = new Set(resolveAllowedFixerRepos(params.agentId));
  if (allowedRepos.size === 0) {
    throw new Error(`No owned repos configured for fixer agent ${params.agentId}`);
  }
  const rawPaths = extractMutatingToolPaths(params.toolName, params.toolParams);
  for (const rawPath of rawPaths) {
    const resolved = resolvePathFromInput(rawPath, params.workspaceRoot);
    const match = matchRepoOwnershipPath(resolved, ownership);
    if (!match || !allowedRepos.has(match.repo.repoId) || !match.owned) {
      logSreMetric("owned_path_rejection", {
        agentId: params.agentId,
        toolName: params.toolName,
        path: rawPath,
      });
      throw new Error(`Owned-path policy blocked ${params.toolName}: ${rawPath}`);
    }
  }
}

async function assertFixerExecScope(params: {
  agentId: string;
  config?: OpenClawConfig;
  workspaceRoot: string;
  toolParams: Record<string, unknown>;
}) {
  const ownership = await loadRepoOwnershipForRuntime({ config: params.config });
  const allowedRepos = new Set(resolveAllowedFixerRepos(params.agentId));
  const workdirRaw =
    typeof params.toolParams.workdir === "string" && params.toolParams.workdir.trim()
      ? params.toolParams.workdir
      : params.workspaceRoot;
  const workdir = resolvePathFromInput(workdirRaw, params.workspaceRoot);
  const match = matchRepoOwnershipPath(workdir, ownership);
  if (!match || !allowedRepos.has(match.repo.repoId)) {
    logSreMetric("owned_path_rejection", {
      agentId: params.agentId,
      toolName: "exec",
      workdir: workdirRaw,
    });
    throw new Error(`Owned-path policy blocked exec outside owned repo: ${workdirRaw}`);
  }
}

export function wrapToolWithOwnedPathPolicy(params: {
  tool: AnyAgentTool;
  agentId?: string;
  config?: OpenClawConfig;
  workspaceRoot: string;
}): AnyAgentTool {
  const role = resolveSreAgentExecutionRole(params.config, params.agentId);
  if (!role || !params.tool.execute) {
    return params.tool;
  }
  const toolName = normalizeToolName(params.tool.name);
  const wrapped: AnyAgentTool = {
    ...params.tool,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      const toolParams =
        rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {};

      if (toolName === "exec") {
        const command = typeof toolParams.command === "string" ? toolParams.command : "";
        if (role !== "fixer" && isMutatingExecCommand(command)) {
          throw new Error(`Read-only agent cannot run mutating exec command: ${command}`);
        }
        if (role === "fixer") {
          await assertFixerExecScope({
            agentId: normalizeAgentId(params.agentId ?? ""),
            config: params.config,
            workspaceRoot: params.workspaceRoot,
            toolParams,
          });
        }
      }

      if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
        if (role !== "fixer") {
          throw new Error(`Read-only agent cannot use ${toolName}`);
        }
        await assertOwnedMutationTargets({
          agentId: normalizeAgentId(params.agentId ?? ""),
          config: params.config,
          workspaceRoot: params.workspaceRoot,
          toolName,
          toolParams,
        });
      }

      return await params.tool.execute(toolCallId, rawParams, signal, onUpdate);
    },
  };
  return wrapped;
}

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
};

export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

export type AllowlistResolution = {
  policy: ToolPolicyLike | undefined;
  unknownAllowlist: string[];
  strippedAllowlist: boolean;
};

export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) {
      continue;
    }
    for (const value of policy.allow) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
  }
  return entries;
}

export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) {
      continue;
    }
    const name = normalizeToolName(tool.name);
    all.push(name);
    const pluginId = meta.pluginId.toLowerCase();
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) {
    return list;
  }
  const expanded: string[] = [];
  for (const entry of list) {
    const normalized = normalizeToolName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized);
    if (tools && tools.length > 0) {
      expanded.push(...tools);
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

export function stripPluginOnlyAllowlist(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const normalized = normalizeToolList(policy.allow);
  if (normalized.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const pluginIds = new Set(groups.byPlugin.keys());
  const pluginTools = new Set(groups.all);
  const unknownAllowlist: string[] = [];
  let hasCoreEntry = false;
  for (const entry of normalized) {
    if (entry === "*") {
      hasCoreEntry = true;
      continue;
    }
    const isPluginEntry =
      entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (isCoreEntry) {
      hasCoreEntry = true;
    }
    if (!isCoreEntry && !isPluginEntry) {
      unknownAllowlist.push(entry);
    }
  }
  const strippedAllowlist = !hasCoreEntry;
  // When an allowlist contains only plugin tools, we strip it to avoid accidentally
  // disabling core tools. Users who want additive behavior should prefer `tools.alsoAllow`.
  if (strippedAllowlist) {
    // Note: logging happens in the caller (pi-tools/tools-invoke) after this function returns.
    // We keep this note here for future maintainers.
  }
  return {
    policy: strippedAllowlist ? { ...policy, allow: undefined } : policy,
    unknownAllowlist: Array.from(new Set(unknownAllowlist)),
    strippedAllowlist,
  };
}

export function mergeAlsoAllowPolicy<TPolicy extends { allow?: string[] }>(
  policy: TPolicy | undefined,
  alsoAllow?: string[],
): TPolicy | undefined {
  if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
    return policy;
  }
  return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
}
