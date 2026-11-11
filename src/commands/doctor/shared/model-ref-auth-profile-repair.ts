import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import type { ModelRefRepair } from "./retired-model-ref-repair.types.js";

export function repairModelRefAuthProfile(
  modelRef: string,
  profileIdMap: ReadonlyMap<string, string> | undefined,
): ModelRefRepair {
  const parsed = splitTrailingAuthProfile(modelRef);
  const profile = parsed.profile ? profileIdMap?.get(parsed.profile) : undefined;
  return profile && profile !== parsed.profile
    ? { kind: "replace", modelRef: `${parsed.model}@${profile}`, reason: "reference-preservation" }
    : { kind: "unchanged" };
}
