import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./sandbox/constants.js";
import type {
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxToolPolicySource,
} from "./sandbox/types.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

type SandboxToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};

function buildSource(params: {
  scope: "agent" | "global" | "default";
  key: string;
}): SandboxToolPolicySource {
  return {
    source: params.scope,
    key: params.key,
  } satisfies SandboxToolPolicySource;
}

function pickConfiguredList(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      values: params.agent,
      source: buildSource({ scope: "agent", key: "agents.list[].tools.sandbox.tools.allow" }),
    };
  }
  if (Array.isArray(params.global)) {
    return {
      values: params.global,
      source: buildSource({ scope: "global", key: "tools.sandbox.tools.allow" }),
    };
  }
  return {
    values: undefined,
    source: buildSource({ scope: "default", key: "tools.sandbox.tools.allow" }),
  };
}

function pickConfiguredDeny(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      values: params.agent,
      source: buildSource({ scope: "agent", key: "agents.list[].tools.sandbox.tools.deny" }),
    };
  }
  if (Array.isArray(params.global)) {
    return {
      values: params.global,
      source: buildSource({ scope: "global", key: "tools.sandbox.tools.deny" }),
    };
  }
  return {
    values: undefined,
    source: buildSource({ scope: "default", key: "tools.sandbox.tools.deny" }),
  };
}

function pickConfiguredAlsoAllow(params: { agent?: string[]; global?: string[] }): {
  values?: string[];
  source?: SandboxToolPolicySource;
} {
  if (Array.isArray(params.agent)) {
    return {
      values: params.agent,
      source: buildSource({
        scope: "agent",
        key: "agents.list[].tools.sandbox.tools.alsoAllow",
      }),
    };
  }
  if (Array.isArray(params.global)) {
    return {
      values: params.global,
      source: buildSource({ scope: "global", key: "tools.sandbox.tools.alsoAllow" }),
    };
  }
  return { values: undefined, source: undefined };
}

function mergeAllowlist(base: string[] | undefined, extra: string[] | undefined): string[] {
  if (Array.isArray(base)) {
    // Preserve the existing sandbox meaning of `allow: []` => allow all.
    if (base.length === 0) {
      return [];
    }
    if (!Array.isArray(extra) || extra.length === 0) {
      return [...base];
    }
    return Array.from(new Set([...base, ...extra]));
  }
  if (Array.isArray(extra) && extra.length > 0) {
    return Array.from(new Set([...DEFAULT_TOOL_ALLOW, ...extra]));
  }
  return [...DEFAULT_TOOL_ALLOW];
}

function pickAllowSource(params: {
  allow: SandboxToolPolicySource;
  allowDefined: boolean;
  alsoAllow?: SandboxToolPolicySource;
}): SandboxToolPolicySource {
  if (params.allowDefined && params.allow.source === "agent") {
    return params.allow;
  }
  if (params.alsoAllow?.source === "agent") {
    return params.alsoAllow;
  }
  if (params.allowDefined && params.allow.source === "global") {
    return params.allow;
  }
  if (params.alsoAllow?.source === "global") {
    return params.alsoAllow;
  }
  return params.allow;
}

function resolveExplicitSandboxReAllowPatterns(params: {
  allow?: string[];
  alsoAllow?: string[];
}): string[] {
  return Array.from(new Set([...(params.allow ?? []), ...(params.alsoAllow ?? [])]));
}

function filterDefaultDenyForExplicitAllows(params: {
  deny: string[];
  explicitAllowPatterns: string[];
}): string[] {
  if (params.explicitAllowPatterns.length === 0) {
    return [...params.deny];
  }
  const allowPatterns = compileGlobPatterns({
    raw: expandToolGroups(params.explicitAllowPatterns),
    normalize: normalizeToolName,
  });
  if (allowPatterns.length === 0) {
    return [...params.deny];
  }
  return params.deny.filter(
    (toolName) => !matchesAnyGlobPattern(normalizeToolName(toolName), allowPatterns),
  );
}

function expandResolvedPolicy(policy: SandboxToolPolicy): SandboxToolPolicy {
  const expandedDeny = expandToolGroups(policy.deny ?? []);
  let expandedAllow = expandToolGroups(policy.allow ?? []);

  // `image` is essential for multimodal workflows; keep the existing sandbox
  // behavior that auto-includes it for explicit allowlists unless it is denied.
  if (
    expandedAllow.length > 0 &&
    !expandedDeny.map((value) => value.toLowerCase()).includes("image") &&
    !expandedAllow.map((value) => value.toLowerCase()).includes("image")
  ) {
    expandedAllow = [...expandedAllow, "image"];
  }

  return {
    allow: expandedAllow,
    deny: expandedDeny,
  };
}

export function resolveEffectiveSandboxToolPolicyForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): SandboxToolPolicyResolved {
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentPolicy = agentConfig?.tools?.sandbox?.tools as SandboxToolPolicyConfig | undefined;
  const globalPolicy = cfg?.tools?.sandbox?.tools as SandboxToolPolicyConfig | undefined;

  const allowConfig = pickConfiguredList({
    agent: agentPolicy?.allow,
    global: globalPolicy?.allow,
  });
  const alsoAllowConfig = pickConfiguredAlsoAllow({
    agent: agentPolicy?.alsoAllow,
    global: globalPolicy?.alsoAllow,
  });
  const denyConfig = pickConfiguredDeny({
    agent: agentPolicy?.deny,
    global: globalPolicy?.deny,
  });

  const explicitAllowPatterns = resolveExplicitSandboxReAllowPatterns({
    allow: allowConfig.values,
    alsoAllow: alsoAllowConfig.values,
  });

  const resolvedAllow = mergeAllowlist(allowConfig.values, alsoAllowConfig.values);
  const resolvedDeny = Array.isArray(denyConfig.values)
    ? [...denyConfig.values]
    : filterDefaultDenyForExplicitAllows({
        deny: [...DEFAULT_TOOL_DENY],
        explicitAllowPatterns,
      });

  const expanded = expandResolvedPolicy({
    allow: resolvedAllow,
    deny: resolvedDeny,
  });

  return {
    allow: expanded.allow ?? [],
    deny: expanded.deny ?? [],
    sources: {
      allow: pickAllowSource({
        allow: allowConfig.source,
        allowDefined: Array.isArray(allowConfig.values),
        alsoAllow: alsoAllowConfig.source,
      }),
      deny: denyConfig.source,
    },
  };
}

function classifyToolAgainstSandboxToolPolicy(name: string, policy?: SandboxToolPolicy) {
  if (!policy) {
    return {
      blockedByDeny: false,
      blockedByAllow: false,
    };
  }

  const normalized = normalizeToolName(name);
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolName,
  });
  const blockedByDeny = matchesAnyGlobPattern(normalized, deny);
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolName,
  });
  const blockedByAllow =
    !blockedByDeny && allow.length > 0 && !matchesAnyGlobPattern(normalized, allow);
  return {
    blockedByDeny,
    blockedByAllow,
  };
}

export function isToolAllowedBySandboxToolPolicy(
  name: string,
  policy?: SandboxToolPolicy,
): boolean {
  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(name, policy);
  return !blockedByDeny && !blockedByAllow;
}

function resolveSandboxModeForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): "off" | "non-main" | "all" {
  const defaults = cfg?.agents?.defaults?.sandbox;
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  return agentConfig?.sandbox?.mode ?? defaults?.mode ?? "off";
}

function shouldSandboxSession(
  mode: "off" | "non-main" | "all",
  sessionKey: string,
  mainKey: string,
) {
  if (mode === "off") {
    return false;
  }
  if (mode === "all") {
    return true;
  }
  return sessionKey.trim() !== mainKey.trim();
}

export function formatEffectiveSandboxToolPolicyBlockedMessage(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  toolName: string;
}): string | undefined {
  const tool = params.toolName.trim().toLowerCase();
  if (!tool) {
    return undefined;
  }

  const sessionKey = params.sessionKey?.trim() ?? "";
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: params.cfg,
  });
  const mainSessionKey =
    params.cfg?.session?.scope === "global"
      ? resolveMainSessionKey(params.cfg)
      : resolveAgentMainSessionKey({
          cfg: params.cfg,
          agentId,
        });
  const comparableSessionKey = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId,
    sessionKey,
  });
  const sandboxMode = resolveSandboxModeForAgent(params.cfg, agentId);
  const sandboxed = sessionKey
    ? shouldSandboxSession(sandboxMode, comparableSessionKey, mainSessionKey)
    : false;
  if (!sandboxed) {
    return undefined;
  }

  const policy = resolveEffectiveSandboxToolPolicyForAgent(params.cfg, agentId);
  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(tool, policy);
  if (!blockedByDeny && !blockedByAllow) {
    return undefined;
  }

  const reasons: string[] = [];
  const fixes: string[] = [];
  if (blockedByDeny) {
    reasons.push("deny list");
    fixes.push(`Remove "${tool}" from ${policy.sources.deny.key}.`);
  }
  if (blockedByAllow) {
    reasons.push("allow list");
    fixes.push(`Add "${tool}" to ${policy.sources.allow.key} (or set it to [] to allow all).`);
  }

  const lines = [
    `Tool "${tool}" blocked by sandbox tool policy (mode=${sandboxMode}).`,
    `Session: ${sessionKey || "(unknown)"}`,
    `Reason: ${reasons.join(" + ")}`,
    "Fix:",
    "- agents.defaults.sandbox.mode=off (disable sandbox)",
    ...fixes.map((fix) => `- ${fix}`),
  ];
  if (sandboxMode === "non-main") {
    lines.push(`- Use main session key (direct): ${mainSessionKey}`);
  }
  lines.push(`- See: ${formatCliCommand(`openclaw sandbox explain --session ${sessionKey}`)}`);
  return lines.join("\n");
}
