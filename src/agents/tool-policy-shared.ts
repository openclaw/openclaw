import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  CORE_TOOL_GROUPS,
  resolveCoreToolProfilePolicy,
  type ToolProfileId,
} from "./tool-catalog.js";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

// Family aliases (WOR-317): a single literal entry in a user's allow/deny list
// expands to itself plus a glob covering every per-action variant. Without
// this, `tools.deny: ["cron"]` would block only the legacy super-tool while
// cron_add / cron_update / cron_remove / ... slipped through every policy
// path (global, per-agent, group, sender, sandbox, inherited, subagent),
// because the matcher does exact-match comparisons after group expansion.
//
// The expansion runs inside expandToolGroups, which every consumer feeds into
// compileGlobPatterns. Keep aliases narrow: only add a family here when a
// shipped public name was decomposed into per-action tools and shipped
// configs reference the parent name.
const TOOL_FAMILY_ALIASES: Record<string, string[]> = {
  cron: ["cron", "cron_*"],
};

export const TOOL_GROUPS: Record<string, string[]> = { ...CORE_TOOL_GROUPS };

export function normalizeToolName(name: string) {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    const family = TOOL_FAMILY_ALIASES[value];
    if (family) {
      expanded.push(...family);
      continue;
    }
    expanded.push(value);
  }
  return Array.from(new Set(expanded));
}

export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  return resolveCoreToolProfilePolicy(profile);
}

export type { ToolProfileId };
