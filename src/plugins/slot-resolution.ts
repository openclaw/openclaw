import { resolveAgentConfig } from "../agents/agent-scope.js";
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
  return Boolean(
    slots && typeof slots === "object" && Object.prototype.hasOwnProperty.call(slots, slotKey),
  );
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
  return {
    recall: resolveMemoryRoleSlot({ ...params, role: "recall" }),
    compaction: resolveMemoryRoleSlot({ ...params, role: "compaction" }),
    capture: resolveMemoryRoleSlot({ ...params, role: "capture" }),
    dreaming: resolveMemoryRoleSlot({ ...params, role: "dreaming" }),
    userModel: resolveMemoryRoleSlot({ ...params, role: "userModel" }),
  };
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
}): MemoryPluginRole[] {
  return MEMORY_PLUGIN_ROLES.filter((role) => isPluginSelectedForMemoryRole({ ...params, role }));
}
