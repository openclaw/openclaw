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

const QVERIS_TOOLS = ["qveris_search", "qveris_execute", "qveris_get_by_ids"] as const;

export const TOOL_GROUPS: Record<string, string[]> = {
  ...CORE_TOOL_GROUPS,
  "group:qveris": [...QVERIS_TOOLS],
  "group:web": Array.from(new Set([...(CORE_TOOL_GROUPS["group:web"] ?? []), ...QVERIS_TOOLS])),
  "group:openclaw": Array.from(
    new Set([...(CORE_TOOL_GROUPS["group:openclaw"] ?? []), ...QVERIS_TOOLS]),
  ),
};

export function normalizeToolName(name: string) {
  const normalized = name.trim().toLowerCase();
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
    expanded.push(value);
  }
  return Array.from(new Set(expanded));
}

export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  // QVeris tools are now registered in tool-catalog.ts with profiles [coding, messaging],
  // so no special-case injection is needed here.
  return resolveCoreToolProfilePolicy(profile);
}

export type { ToolProfileId };
