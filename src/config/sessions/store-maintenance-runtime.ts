import { getRuntimeConfig } from "../config.js";
import type { SessionMaintenanceConfig } from "../types.base.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

export type SessionMaintenancePreserveKeysProvider = () => Iterable<string> | undefined;

const preserveKeysProviders = new Set<SessionMaintenancePreserveKeysProvider>();

export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = getRuntimeConfig().session?.maintenance;
  } catch {
    // Config may not be available in narrow test/runtime helpers.
  }
  return resolveMaintenanceConfigFromInput(maintenance);
}

export function registerSessionMaintenancePreserveKeysProvider(
  provider: SessionMaintenancePreserveKeysProvider,
): () => void {
  preserveKeysProviders.add(provider);
  return () => {
    preserveKeysProviders.delete(provider);
  };
}

export function collectSessionMaintenancePreserveKeys(
  seedKeys?: Iterable<string | undefined>,
): Set<string> | undefined {
  let preserveKeys: Set<string> | undefined;
  const addKey = (key: string | undefined) => {
    const trimmed = key?.trim();
    if (!trimmed) {
      return;
    }
    preserveKeys ??= new Set<string>();
    preserveKeys.add(trimmed);
  };

  for (const key of seedKeys ?? []) {
    addKey(key);
  }
  for (const provider of preserveKeysProviders) {
    try {
      for (const key of provider() ?? []) {
        addKey(key);
      }
    } catch {
      // Preserve providers are lifecycle hints; maintenance must remain best-effort.
    }
  }
  return preserveKeys;
}
