import DEFAULT_SECURITY_POLICY_JSON from "../../config/security-policy.json" with { type: "json" };
import type {
  SkillSecurityPackageMetadata,
  SkillSecurityPolicyAction,
  SkillSecurityPolicyDecision,
  SkillSecurityVerdict,
} from "./skill-security-types.js";

export type SkillSecurityPolicyConfig = {
  version: number;
  defaults: Record<SkillSecurityVerdict, SkillSecurityPolicyAction>;
  thresholds: {
    allowMinConfidence: number;
    suspiciousManualReviewMinConfidence: number;
    blockMinConfidence: number;
  };
};

const DEFAULT_POLICY = DEFAULT_SECURITY_POLICY_JSON as SkillSecurityPolicyConfig;

export function mapVerdictToAction(params: {
  verdict: SkillSecurityVerdict;
  confidence: number;
  metadata?: SkillSecurityPackageMetadata;
  config?: SkillSecurityPolicyConfig;
}): SkillSecurityPolicyDecision {
  const config = params.config ?? DEFAULT_POLICY;
  const reasons: string[] = [];
  let action: SkillSecurityPolicyAction;

  switch (params.verdict) {
    case "benign":
      if (params.confidence >= config.thresholds.allowMinConfidence) {
        action = config.defaults.benign;
        reasons.push("Benign verdict met allow confidence threshold.");
      } else {
        action = "warn";
        reasons.push("Benign verdict confidence too low for silent allow.");
      }
      break;
    case "suspicious":
      action =
        params.confidence >= config.thresholds.suspiciousManualReviewMinConfidence
          ? "manual_review"
          : "warn";
      reasons.push("Suspicious verdict requires operator attention.");
      break;
    case "malicious":
      action =
        params.confidence >= config.thresholds.blockMinConfidence ? "block" : "manual_review";
      reasons.push("Malicious verdict indicates the package must not be trusted automatically.");
      break;
    case "unknown":
      action = config.defaults.unknown;
      reasons.push("Unknown verdict cannot be trusted automatically.");
      break;
    case "error":
    default:
      action = config.defaults.error;
      reasons.push("Scanner error requires manual review.");
      break;
  }

  const trustLevel = params.metadata?.publisher.trustLevel ?? "unknown";
  if (trustLevel === "unknown" && action === "allow") {
    action = "warn";
    reasons.push("Unknown publisher trust level upgraded allow to warn.");
  }

  return {
    action,
    reasons,
    decidedAt: new Date().toISOString(),
  };
}
