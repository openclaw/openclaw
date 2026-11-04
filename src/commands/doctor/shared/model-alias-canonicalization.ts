import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDoctorModelRefResolver } from "./model-reference-resolver.js";
import type { DoctorModelReplacement } from "./model-replacement.js";

/** Materialize the old identity before moving an alias; this changes no model or Access choice. */
export function createModelAliasCanonicalizer(
  cfg: OpenClawConfig,
  choices: readonly DoctorModelReplacement[],
) {
  const resolve = createDoctorModelRefResolver(cfg);
  const sources = new Set(choices.map((choice) => choice.from));
  return (raw: string, agentId: string): string | undefined => {
    const parsed = splitTrailingAuthProfile(raw);
    const canonical = resolve(raw, agentId);
    if (!canonical || !sources.has(canonical) || parsed.model === canonical) {
      return undefined;
    }
    return parsed.profile ? canonical + "@" + parsed.profile : canonical;
  };
}
