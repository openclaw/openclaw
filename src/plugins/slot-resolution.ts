import { listAgentEntries, resolveAgentConfig } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginSlotsConfig } from "../config/types.plugins.js";
import { normalizePluginsConfig } from "./config-state.js";

export type MemoryPluginRole = "recall" | "compaction" | "capture" | "dreaming" | "userModel";

export const MEMORY_PLUGIN_ROLES = [
  "recall",
  "compaction",
  "capture",
  "dreaming",
  "userModel",
] as const satisfies readonly MemoryPluginRole[];

export type MemoryPluginRoleSlotKey = Exclude<keyof PluginSlotsConfig, "memory" | "contextEngine">;

export function memoryRoleToSlotKey(role: MemoryPluginRole): MemoryPluginRoleSlotKey {
  return `memory.${role}` as MemoryPluginRoleSlotKey;
}

function hasOwnSlot(slots: unknown, slotKey: string): boolean {
  return Boolean(slots && typeof slots === "object" && Object.hasOwn(slots, slotKey));
}

export function resolvePluginSlot(params: {
  cfg: OpenClawConfig;
  slotKey: keyof PluginSlotsConfig;
  agentId?: string;
  legacySlotKey?: keyof PluginSlotsConfig;
}): string | null | undefined {
  const globalPlugins = normalizePluginsConfig(params.cfg.plugins);
  let slot = globalPlugins.slots[params.slotKey];
  if (slot === undefined && params.legacySlotKey) {
    slot = globalPlugins.slots[params.legacySlotKey];
  }

  const agentSlots = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.plugins?.slots
    : undefined;
  const hasAgentSlot = hasOwnSlot(agentSlots, params.slotKey);
  const hasAgentLegacySlot = params.legacySlotKey
    ? hasOwnSlot(agentSlots, params.legacySlotKey)
    : false;
  if (!hasAgentSlot && !hasAgentLegacySlot) {
    return slot;
  }

  const agentPlugins = normalizePluginsConfig({ slots: agentSlots });
  if (hasAgentSlot) {
    return agentPlugins.slots[params.slotKey];
  }
  return params.legacySlotKey ? agentPlugins.slots[params.legacySlotKey] : slot;
}

export function resolveMemoryRoleSlot(params: {
  cfg: OpenClawConfig;
  role: MemoryPluginRole;
  agentId?: string;
}): string | null | undefined {
  return resolvePluginSlot({
    cfg: params.cfg,
    slotKey: memoryRoleToSlotKey(params.role),
    agentId: params.agentId,
    legacySlotKey: params.role === "recall" ? "memory" : undefined,
  });
}

export function resolveMemoryRoleSlots(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Record<MemoryPluginRole, string | null | undefined> {
  return Object.fromEntries(
    MEMORY_PLUGIN_ROLES.map((role) => [role, resolveMemoryRoleSlot({ ...params, role })]),
  ) as Record<MemoryPluginRole, string | null | undefined>;
}

export type MemoryRoleSlotSelection = {
  role: MemoryPluginRole;
  slotKey: MemoryPluginRoleSlotKey;
  pluginId: string;
  agentId?: string;
};

function addMemoryRoleSlotSelection(
  selections: MemoryRoleSlotSelection[],
  params: {
    role: MemoryPluginRole;
    pluginId: string | null | undefined;
    agentId?: string;
  },
): void {
  if (typeof params.pluginId !== "string") {
    return;
  }
  const pluginId = params.pluginId.trim();
  if (!pluginId || pluginId.toLowerCase() === "none") {
    return;
  }
  selections.push({
    role: params.role,
    slotKey: memoryRoleToSlotKey(params.role),
    pluginId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}

function addConfiguredMemoryRoleSlotSelections(
  selections: MemoryRoleSlotSelection[],
  params: {
    cfg: OpenClawConfig;
    slots: unknown;
    agentId?: string;
  },
): void {
  for (const role of MEMORY_PLUGIN_ROLES) {
    const slotKey = memoryRoleToSlotKey(role);
    const hasRoleSlot = hasOwnSlot(params.slots, slotKey);
    const hasLegacyRecallSlot = role === "recall" && hasOwnSlot(params.slots, "memory");
    if (!hasRoleSlot && !hasLegacyRecallSlot) {
      continue;
    }
    addMemoryRoleSlotSelection(selections, {
      role,
      pluginId: resolveMemoryRoleSlot({
        cfg: params.cfg,
        role,
        agentId: params.agentId,
      }),
      agentId: params.agentId,
    });
  }
}

export function listConfiguredMemoryRoleSlotSelections(params: {
  cfg: OpenClawConfig;
}): MemoryRoleSlotSelection[] {
  const selections: MemoryRoleSlotSelection[] = [];
  addConfiguredMemoryRoleSlotSelections(selections, {
    cfg: params.cfg,
    slots: params.cfg.plugins?.slots,
  });
  for (const agent of listAgentEntries(params.cfg)) {
    const agentId = agent.id?.trim();
    if (!agentId || !agent.plugins?.slots) {
      continue;
    }
    addConfiguredMemoryRoleSlotSelections(selections, {
      cfg: params.cfg,
      slots: agent.plugins.slots,
      agentId,
    });
  }
  return selections;
}

export function listConfiguredMemoryRolePluginIds(params: { cfg: OpenClawConfig }): string[] {
  return [
    ...new Set(
      listConfiguredMemoryRoleSlotSelections(params).map((selection) => selection.pluginId),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function listMemoryRoleSlotDecisionValues(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  includeConfiguredAgentSlots?: boolean;
  slotValues?: Iterable<string | null | undefined>;
}): (string | null | undefined)[] {
  return [
    ...new Set([
      ...(params.slotValues ??
        Object.values(resolveMemoryRoleSlots({ cfg: params.cfg, agentId: params.agentId }))),
      ...(params.includeConfiguredAgentSlots
        ? listConfiguredMemoryRolePluginIds({ cfg: params.cfg })
        : []),
    ]),
  ];
}

export function listSelectedMemoryRolePluginIds(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  const plugins = normalizePluginsConfig(params.cfg.plugins);
  if (!plugins.enabled) {
    return [];
  }
  const ids = new Set<string>();
  for (const slot of Object.values(resolveMemoryRoleSlots(params))) {
    if (typeof slot !== "string") {
      continue;
    }
    const pluginId = slot.trim();
    if (!pluginId) {
      continue;
    }
    if (pluginId.toLowerCase() === "none") {
      continue;
    }
    if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) {
      continue;
    }
    ids.add(pluginId);
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

export function isPluginSelectedForMemoryRole(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  role: MemoryPluginRole;
  agentId?: string;
}): boolean {
  const plugins = normalizePluginsConfig(params.cfg.plugins);
  if (
    !plugins.enabled ||
    plugins.deny.includes(params.pluginId) ||
    plugins.entries[params.pluginId]?.enabled === false
  ) {
    return false;
  }
  return resolveMemoryRoleSlot(params)?.trim() === params.pluginId;
}

export function listMemoryRolesSelectedForPlugin(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  agentId?: string;
  includeConfiguredAgentSlots?: boolean;
}): MemoryPluginRole[] {
  const roles = new Set<MemoryPluginRole>(
    MEMORY_PLUGIN_ROLES.filter((role) => isPluginSelectedForMemoryRole({ ...params, role })),
  );
  if (params.includeConfiguredAgentSlots) {
    for (const selection of listConfiguredMemoryRoleSlotSelections({ cfg: params.cfg })) {
      if (selection.pluginId === params.pluginId) {
        roles.add(selection.role);
      }
    }
  }
  return [...roles];
}
