import type { OpenClawConfig } from "../config/config.js";

export type PluginCapabilityKind = "search-provider";
export type PluginCapabilitySlotMode = "multi" | "exclusive";

export type CapabilitySlotId = "providers.search" | "memory.backend";

type CapabilityKindDefinition = {
  capabilityPrefix: string;
  slot: CapabilitySlotId;
  slotMode: PluginCapabilitySlotMode;
};

type CapabilitySlotDefinition = {
  configPath: string;
  read: (config: OpenClawConfig | undefined) => string | null | undefined;
  write: (config: OpenClawConfig, selectedId: string | null) => OpenClawConfig;
};

const DEFAULT_MEMORY_BACKEND = "memory-core";

function normalizeSelection(value: unknown): string | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  return trimmed;
}

const CAPABILITY_KIND_DEFINITIONS: Record<PluginCapabilityKind, CapabilityKindDefinition> = {
  "search-provider": {
    capabilityPrefix: "providers.search",
    slot: "providers.search",
    slotMode: "multi",
  },
};

const CAPABILITY_SLOT_DEFINITIONS: Record<CapabilitySlotId, CapabilitySlotDefinition> = {
  "providers.search": {
    configPath: "tools.web.search.provider",
    read: (config) => normalizeSelection(config?.tools?.web?.search?.provider),
    write: (config, selectedId) => ({
      ...config,
      tools: {
        ...config.tools,
        web: {
          ...config.tools?.web,
          search: {
            ...config.tools?.web?.search,
            provider: selectedId ?? undefined,
          },
        },
      },
    }),
  },
  "memory.backend": {
    configPath: "plugins.slots.memory",
    read: (config) => {
      const configured = normalizeSelection(config?.plugins?.slots?.memory);
      return configured === undefined ? DEFAULT_MEMORY_BACKEND : configured;
    },
    write: (config, selectedId) => ({
      ...config,
      plugins: {
        ...config.plugins,
        slots: {
          ...config.plugins?.slots,
          memory: selectedId ?? "none",
        },
      },
    }),
  },
};

export function buildCapabilityName(kind: PluginCapabilityKind, id: string): string {
  const definition = CAPABILITY_KIND_DEFINITIONS[kind];
  return `${definition.capabilityPrefix}.${id}`;
}

export function resolveCapabilitySlotForKind(kind: PluginCapabilityKind): CapabilitySlotId {
  return CAPABILITY_KIND_DEFINITIONS[kind].slot;
}

export function resolveCapabilitySlotModeForKind(
  kind: PluginCapabilityKind,
): PluginCapabilitySlotMode {
  return CAPABILITY_KIND_DEFINITIONS[kind].slotMode;
}

export function resolveCapabilitySlotConfigPath(slot: CapabilitySlotId): string {
  return CAPABILITY_SLOT_DEFINITIONS[slot].configPath;
}

export function resolveCapabilitySlotSelection(
  config: OpenClawConfig | undefined,
  slot: CapabilitySlotId,
): string | null | undefined {
  return CAPABILITY_SLOT_DEFINITIONS[slot].read(config);
}

export function applyCapabilitySlotSelection(params: {
  config: OpenClawConfig;
  slot: CapabilitySlotId;
  selectedId: string | null;
}): OpenClawConfig {
  const selectedId =
    params.selectedId === null ? null : (normalizeSelection(params.selectedId) ?? undefined);
  return CAPABILITY_SLOT_DEFINITIONS[params.slot].write(params.config, selectedId ?? null);
}
