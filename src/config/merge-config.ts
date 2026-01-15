import type { ClawdbotConfig } from "./config.js";
import type { WhatsAppConfig } from "./types.js";

export type MergeSectionOptions<T> = {
  unsetOnUndefined?: Array<keyof T>;
};

export function mergeConfigSection<T extends Record<string, unknown>>(
  base: T | undefined,
  patch: Partial<T>,
  options: MergeSectionOptions<T> = {},
): T {
  const next: Record<string, unknown> = { ...(base ?? undefined) };
  for (const [key, value] of Object.entries(patch) as [keyof T, T[keyof T]][]) {
    if (value === undefined) {
      if (options.unsetOnUndefined?.includes(key)) {
        delete next[key as string];
      }
      continue;
    }
    next[key as string] = value as unknown;
  }
  return next as T;
}

export function mergeWhatsAppConfig(
  cfg: ClawdbotConfig,
  patch: Partial<WhatsAppConfig>,
  options?: MergeSectionOptions<WhatsAppConfig>,
): ClawdbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: mergeConfigSection(cfg.channels?.whatsapp, patch, options),
    },
  };
}

export function upsertSkillEntry(
  cfg: ClawdbotConfig,
  skillKey: string,
  patch: { apiKey?: string },
): ClawdbotConfig {
  if (!skillKey || skillKey.length > 100) {
    throw new Error(`Invalid skillKey: ${skillKey}`);
  }
  if (patch.apiKey && patch.apiKey.length > 1000) {
    throw new Error("API key exceeds maximum length");
  }

  const entries = { ...cfg.skills?.entries };
  const existing = (entries[skillKey] as { apiKey?: string } | undefined) ?? {};
  entries[skillKey] = { ...existing, ...patch };
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      entries,
    },
  };
}
