// Loads the bundled, presentation-only onboarding install catalog.
import recommendedToolInstalls from "../../scripts/lib/recommended-tool-installs.json" with { type: "json" };
import { normalizeSetupPresentationHttpsUrl } from "./setup-presentation-url.js";

export type SetupRecommendedInstall = {
  id: string;
  brandId?: string;
  label: string;
  hint: string;
  website: string;
  icon: string;
};

export function listRecommendedToolInstalls(): SetupRecommendedInstall[] {
  const seenIds = new Set<string>();
  const installs: SetupRecommendedInstall[] = [];
  for (const entry of recommendedToolInstalls.entries) {
    const id = entry.id.trim();
    const brandId = entry.brandId?.trim();
    const label = entry.label.trim();
    const hint = entry.hint.trim();
    const website = normalizeSetupPresentationHttpsUrl(entry.website);
    const icon = normalizeSetupPresentationHttpsUrl(entry.icon);
    if (!id || seenIds.has(id) || !label || !hint || !website || !icon) {
      continue;
    }
    seenIds.add(id);
    installs.push({ id, ...(brandId ? { brandId } : {}), label, hint, website, icon });
  }
  return installs;
}
