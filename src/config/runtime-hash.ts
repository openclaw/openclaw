import type { OpenClawConfig } from "./types.js";

const configRuntimeHashByObject = new WeakMap<OpenClawConfig, string>();

function normalizeHash(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function setConfigRuntimeHash(cfg: OpenClawConfig, hash: string | null | undefined): void {
  const normalized = normalizeHash(hash);
  if (!normalized) {
    configRuntimeHashByObject.delete(cfg);
    return;
  }
  configRuntimeHashByObject.set(cfg, normalized);
}

export function getConfigRuntimeHash(cfg: OpenClawConfig): string | null {
  return configRuntimeHashByObject.get(cfg) ?? null;
}
