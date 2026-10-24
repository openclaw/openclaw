import {
  CLAWHUB_SKILLS_SH_TRUST_LABEL,
  type ClawHubSkillVerificationResponse,
} from "../infra/clawhub-skills.js";
import {
  readVerifiedClawHubSkillSourceUrl,
  type resolveClawHubSkillVerificationTarget,
} from "../skills/lifecycle/clawhub.js";

export function buildSkillVerificationOutput(
  result: ClawHubSkillVerificationResponse,
  target: Extract<Awaited<ReturnType<typeof resolveClawHubSkillVerificationTarget>>, { ok: true }>,
): Record<string, unknown> {
  const verifiedSourceUrl = readVerifiedClawHubSkillSourceUrl(result.provenance);
  return {
    ...result,
    openclaw: {
      resolution: {
        source: target.resolution.source,
        selector: target.resolution.selector,
        registry: target.resolution.registry,
        installedVersion: target.resolution.installedVersion,
        ...(target.requestedReference ? { reference: target.requestedReference } : {}),
      },
      ...(target.trustState
        ? {
            trust: {
              state: target.trustState,
              label: CLAWHUB_SKILLS_SH_TRUST_LABEL,
            },
          }
        : {}),
      ...(verifiedSourceUrl ? { verifiedSourceUrl } : {}),
    },
  };
}
