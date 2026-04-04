import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import {
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "./tool-policy.js";

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  allowedPaths?: string[];
  denyPaths?: string[];
};

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  allowedPaths?: string[];
  denyPaths?: string[];
}): ToolFsPolicy {
  return {
    workspaceOnly: params.workspaceOnly === true,
    allowedPaths: params.allowedPaths,
    denyPaths: params.denyPaths,
  };
}

export function resolveToolFsConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): {
  workspaceOnly?: boolean;
  allowedPaths?: string[];
  denyPaths?: string[];
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId
      ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs
      : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
    allowedPaths: agentFs?.allowedPaths ?? globalFs?.allowedPaths,
    denyPaths: agentFs?.denyPaths ?? globalFs?.denyPaths,
  };
}

export type ToolFsPolicyCombineParams = {
  globalPolicy?: Partial<ToolFsPolicy>;
  agentPolicy?: Partial<ToolFsPolicy>;
  spawnPolicy?: Partial<ToolFsPolicy>;
};

function normalizeList(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.map((v) => v.trim()).filter(Boolean);
  return out.length > 0 ? out : [];
}

function union(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  const merged = [...(a ?? []), ...(b ?? [])];
  return merged.length > 0 ? Array.from(new Set(merged)) : [];
}

function intersectAll(
  lists: Array<string[] | undefined>,
): string[] | undefined {
  const defined = lists.filter((v) => v !== undefined);
  if (defined.length === 0) {
    return undefined;
  }
  // If any level explicitly sets an empty allowlist, deny all.
  if (defined.some((v) => v.length === 0)) {
    return [];
  }

  // allowedPaths is a glob allowlist. Tightening should remain usable even when
  // a stricter list uses different (more specific) patterns.
  //
  // Conservative intersection:
  // - If the next list is (heuristically) a subset of the current list, keep next (tighter).
  // - Else if current is subset of next, keep current.
  // - Else fall back to exact-token intersection.
  const isSubsetByPrefixHeuristic = (a: string[], b: string[]) => {
    const normalize = (p: string) => p.replace(/\\/g, "/").trim();
    const asPrefix = (p: string) => {
      const n = normalize(p);
      return n.endsWith("/**") ? n.slice(0, -3) : null;
    };
    return b.every((bp) => {
      const bNorm = normalize(bp);
      return a.some((ap) => {
        if (ap === bp) {
          return true;
        }
        const aPrefix = asPrefix(ap);
        if (aPrefix) {
          return bNorm === aPrefix || bNorm.startsWith(aPrefix + "/");
        }
        return false;
      });
    });
  };

  let acc = defined[0];
  for (const next of defined.slice(1)) {
    if (isSubsetByPrefixHeuristic(acc, next)) {
      acc = next;
      continue;
    }
    if (isSubsetByPrefixHeuristic(next, acc)) {
      continue;
    }

    const nextSet = new Set(next);
    acc = acc.filter((v) => nextSet.has(v));
  }

  return acc;
}

export function combineToolFsPolicies(
  params: ToolFsPolicyCombineParams,
): ToolFsPolicy {
  const globalAllowed = normalizeList(params.globalPolicy?.allowedPaths);
  const agentAllowed = normalizeList(params.agentPolicy?.allowedPaths);
  const spawnAllowed = normalizeList(params.spawnPolicy?.allowedPaths);

  const globalDeny = normalizeList(params.globalPolicy?.denyPaths);
  const agentDeny = normalizeList(params.agentPolicy?.denyPaths);
  const spawnDeny = normalizeList(params.spawnPolicy?.denyPaths);

  const allowedPaths = intersectAll([
    globalAllowed,
    agentAllowed,
    spawnAllowed,
  ]);
  const denyPaths = union(union(globalDeny, agentDeny), spawnDeny);

  const workspaceOnly =
    params.globalPolicy?.workspaceOnly === true ||
    params.agentPolicy?.workspaceOnly === true ||
    params.spawnPolicy?.workspaceOnly === true;

  return {
    workspaceOnly,
    allowedPaths,
    denyPaths,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}

export function resolveEffectiveToolFsRootExpansionAllowed(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  const cfg = params.cfg;
  if (!cfg) {
    return true;
  }
  const agentTools = params.agentId
    ? resolveAgentConfig(cfg, params.agentId)?.tools
    : undefined;
  const globalTools = cfg.tools;
  const profile = agentTools?.profile ?? globalTools?.profile;
  const profileAlsoAllow = new Set(
    agentTools?.alsoAllow ?? globalTools?.alsoAllow ?? [],
  );
  const fsConfig = resolveToolFsConfig(params);
  const hasExplicitFsConfig =
    agentTools?.fs !== undefined || globalTools?.fs !== undefined;
  if (fsConfig.workspaceOnly === true) {
    return false;
  }
  if (hasExplicitFsConfig) {
    profileAlsoAllow.add("read");
    profileAlsoAllow.add("write");
    profileAlsoAllow.add("edit");
  }
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    profileAlsoAllow.size > 0 ? Array.from(profileAlsoAllow) : undefined,
  );
  const globalPolicy = pickSandboxToolPolicy(globalTools);
  const agentPolicy = pickSandboxToolPolicy(agentTools);
  return isToolAllowedByPolicies("read", [
    profilePolicy,
    globalPolicy,
    agentPolicy,
  ]);
}
