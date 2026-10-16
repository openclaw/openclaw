import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";

registerSkillWorkshopEnglish();

export type SkillWorkshopMode = "off" | "auto";

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
): Promise<string | null> {
  const patch = {
    raw: { skills: { workshop: { autonomous: { mode } } } },
    note:
      mode === "auto" ? "Enable Skill Workshop auto-learning" : "Disable Skill Workshop learning",
  };
  const patched = await runtimeConfig.patch(patch);
  if (!patched) {
    return runtimeConfig.state.lastError ?? t("skillWorkshop.mode.updateError");
  }
  await runtimeConfig.refresh();
  return null;
}
