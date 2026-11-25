import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";

registerSkillWorkshopEnglish();

export type SkillWorkshopMode = "off" | "propose" | "auto";

export function resolveWorkshopMode(
  runtimeConfig: RuntimeConfigCapability | undefined,
): SkillWorkshopMode | null {
  const config = resolveEditableSnapshotConfig(runtimeConfig?.state.configSnapshot);
  if (!config) {
    return null;
  }
  // The Gateway defaults an absent mode to auto; any other value learns nothing.
  const entry = asRecord(asRecord(asRecord(config.plugins)?.entries)?.["skill-workshop"]);
  const configured = asRecord(asRecord(entry?.config)?.autonomous)?.mode;
  if (configured === undefined || configured === "auto") {
    return "auto";
  }
  return configured === "propose" ? "propose" : "off";
}

/** True only when the loaded config turns every plugin off; unknown stays false. */
export function arePluginsDisabled(runtimeConfig: RuntimeConfigCapability | undefined): boolean {
  const config = resolveEditableSnapshotConfig(runtimeConfig?.state.configSnapshot);
  return asRecord(config?.plugins)?.enabled === false;
}

/** Patch the plugin's own config key; returns an error message or null on success. */
export async function setWorkshopMode(
  runtimeConfig: RuntimeConfigCapability,
  mode: SkillWorkshopMode,
): Promise<string | null> {
  const patch = {
    raw: { plugins: { entries: { "skill-workshop": { config: { autonomous: { mode } } } } } },
    note: {
      auto: "Enable Skill Workshop auto-learning",
      propose: "Have Skill Workshop propose drafts",
      off: "Disable Skill Workshop learning",
    }[mode],
  };
  const patched = await runtimeConfig.patch(patch);
  if (!patched) {
    return runtimeConfig.state.lastError ?? t("skillWorkshop.mode.updateError");
  }
  await runtimeConfig.refresh();
  return null;
}
