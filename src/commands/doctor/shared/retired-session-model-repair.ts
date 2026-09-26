import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
} from "../../../sessions/model-overrides.js";
import type { ModelRefRepairResolver } from "./retired-model-ref-repair.js";

/** Session selection owns invalidation of context/fallback metadata and profile preservation. */
export function repairRetiredSessionModelRef(
  entry: SessionEntry,
  agentId: string,
  resolve: ModelRefRepairResolver,
  defaultModelRef: string | undefined,
  warnings: string[],
): boolean {
  if (!entry.modelOverride || isModelSelectionLocked(entry)) {
    return false;
  }
  const modelRef = entry.providerOverride
    ? `${entry.providerOverride}/${entry.modelOverride}`
    : entry.modelOverride;
  const decision = resolve({
    modelRef,
    agentId,
    authProfileId: entry.authProfileOverride,
    authProfileSource: entry.authProfileOverrideSource,
  });
  if (decision.kind === "unchanged") {
    return false;
  }
  const replacement = splitTrailingAuthProfile(
    decision.kind === "replace" ? decision.modelRef : (defaultModelRef ?? ""),
  ).model;
  if (
    decision.kind === "clear" &&
    replacement === decision.modelRef &&
    entry.authProfileOverride &&
    (entry.authProfileOverrideSource === "user" || entry.authProfileOverrideSource === "user-link")
  ) {
    const warning = `Retained retired ${decision.modelRef} for agent "${agentId}": clearing this session override would still select it with the same pinned account. Choose a supported default or an allowed model override, then rerun openclaw doctor --fix.`;
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
    return false;
  }
  const slash = replacement.indexOf("/");
  return applyModelOverrideToSessionEntry({
    entry,
    selection: {
      provider: replacement.slice(0, slash),
      model: replacement.slice(slash + 1),
      isDefault: decision.kind === "clear",
    },
    preserveAuthProfileOverride:
      decision.kind === "replace" || replacement.slice(0, slash) === decision.provider,
    selectionSource: entry.modelOverrideSource === "auto" ? "auto" : "user",
  }).updated;
}
