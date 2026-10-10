import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";

registerSkillWorkshopEnglish();

export type SkillWorkshopMode = "off" | "auto";

const CONFIG_CHANGED_SINCE_LOAD = "config changed since last load";

export function resolveWorkshopMode(
  runtimeConfig: RuntimeConfigCapability | undefined,
): SkillWorkshopMode | null {
  const config = resolveEditableSnapshotConfig(runtimeConfig?.state.configSnapshot);
  if (!config) {
    return null;
  }
  // The Gateway defaults an absent mode to auto; any other value learns nothing.
  const configured = asRecord(asRecord(asRecord(config.skills)?.workshop)?.autonomous)?.mode;
  return configured === undefined || configured === "auto" ? "auto" : "off";
}

/** Patch the canonical config key; returns an error message or null on success. */
export async function setWorkshopMode(
  runtimeConfig: RuntimeConfigCapability,
  mode: SkillWorkshopMode,
  isCurrent: () => boolean,
): Promise<string | null> {
  const patch = {
    raw: { skills: { workshop: { autonomous: { mode } } } },
    note:
      mode === "auto" ? "Enable Skill Workshop auto-learning" : "Disable Skill Workshop learning",
  };
  let patched = await runtimeConfig.patch(patch);
  if (!isCurrent()) {
    return null;
  }
  if (!patched && runtimeConfig.state.lastError?.includes(CONFIG_CHANGED_SINCE_LOAD)) {
    // This scalar switch is safe to replay after refreshing the optimistic-lock hash.
    await runtimeConfig.refresh();
    if (!isCurrent()) {
      return null;
    }
    if (runtimeConfig.state.lastError) {
      return runtimeConfig.state.lastError;
    }
    patched = await runtimeConfig.patch(patch);
    if (!isCurrent()) {
      return null;
    }
  }
  if (!patched) {
    return runtimeConfig.state.lastError ?? t("skillWorkshop.mode.updateError");
  }
  await runtimeConfig.refresh();
  return null;
}
