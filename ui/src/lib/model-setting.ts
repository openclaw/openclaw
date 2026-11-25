import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentModelConfig } from "../../../src/config/types.agents-shared.js";

export function readModelSetting(value: unknown): AgentModelConfig | null {
  if (typeof value === "string") {
    return value;
  }
  const record = asNullableRecord(value);
  return record
    ? {
        ...(typeof record.primary === "string" ? { primary: record.primary } : {}),
        ...(Array.isArray(record.fallbacks)
          ? {
              fallbacks: record.fallbacks.filter(
                (entry): entry is string => typeof entry === "string",
              ),
            }
          : {}),
      }
    : null;
}

export function modelSettingPrimary(setting: AgentModelConfig | null): string | undefined {
  // Preserve authored empty strings: utility routing uses them to mean disabled.
  return typeof setting === "string" ? setting : setting?.primary;
}

export function modelSettingFallbacks(setting: AgentModelConfig | null): string[] {
  return typeof setting === "object" ? (setting?.fallbacks ?? []) : [];
}

export function modelSettingPatch(setting: AgentModelConfig | null) {
  // Merge patches must explicitly remove a primary when restoring automatic routing.
  return setting && typeof setting === "object"
    ? { ...setting, primary: setting.primary ?? null }
    : setting;
}

export function withModelSettingPrimary(
  setting: AgentModelConfig | null,
  primary: string | null,
): AgentModelConfig | null {
  if (typeof setting === "object" && setting?.fallbacks !== undefined) {
    return {
      ...(primary !== null ? { primary } : {}),
      fallbacks: setting.fallbacks.filter((fallback) => fallback !== primary),
    };
  }
  return primary;
}
