import type { RuntimeEnv } from "../runtime.js";
import {
  acknowledgeOnboardingRecommendations,
  readOnboardingRecommendations,
  type OnboardingRecommendationsRecord,
} from "../state/onboarding-recommendations.js";

type OnboardRecommendationsDeps = {
  read?: () => OnboardingRecommendationsRecord | null;
  acknowledge?: () => OnboardingRecommendationsRecord | null;
};

const SAFE_INSTALL_ID_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;

type BootstrapRecommendation = {
  id: string;
  source: "official-plugin" | "clawhub-skill";
  tier: "recommended" | "optional";
};

function bootstrapRecommendations(
  record: OnboardingRecommendationsRecord | null,
): BootstrapRecommendation[] {
  if (record?.acceptedAt != null) {
    return [];
  }
  return (record?.matches ?? []).flatMap((match) => {
    const id = match.candidate.id;
    if (!SAFE_INSTALL_ID_RE.test(id)) {
      return [];
    }
    return [
      {
        id,
        source: match.candidate.source === "clawhub-skill" ? "clawhub-skill" : "official-plugin",
        tier: match.tier,
      },
    ];
  });
}

export function onboardRecommendationsCommand(
  opts: { json?: boolean },
  runtime: RuntimeEnv,
  deps: OnboardRecommendationsDeps = {},
): void {
  const record = (deps.read ?? readOnboardingRecommendations)();
  // The bootstrap consumes only safe opaque install ids. Marketplace prose,
  // model reasons, and local app labels are untrusted prompt input.
  const matches = bootstrapRecommendations(record);
  if (opts.json) {
    runtime.log(JSON.stringify(matches, null, 2));
    return;
  }
  if (matches.length === 0) {
    runtime.log("No stored onboarding recommendations.");
    return;
  }
  runtime.log(
    matches
      .map((match) => {
        const source = match.source === "clawhub-skill" ? "ClawHub skill" : "official plugin";
        return `- ${match.id} [${source}; ${match.tier}]`;
      })
      .join("\n"),
  );
}

export function acknowledgeOnboardRecommendationsCommand(
  runtime: RuntimeEnv,
  deps: OnboardRecommendationsDeps = {},
): void {
  const record = (deps.acknowledge ?? acknowledgeOnboardingRecommendations)();
  runtime.log(record ? "Onboarding recommendations acknowledged." : "No stored recommendations.");
}
