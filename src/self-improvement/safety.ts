import type {
  SelfImprovementRecommendationCategory,
  SelfImprovementRecommendationRoute,
  SelfImprovementRecommendationSafety,
} from "./types.js";

const BLOCKED_ACTIONS = [
  "no direct merge, push, or release",
  "no destructive file actions",
  "no secret exposure",
  "no uncontrolled Skill Workshop writes",
  "no code or config change without tests or explicit approval",
];

function categoryRequiresTests(category: SelfImprovementRecommendationCategory): boolean {
  switch (category) {
    case "task_reliability":
    case "smoke_failure":
    case "model_routing":
    case "verification_gap":
    case "project_health":
    case "efficiency_opportunity":
    case "architecture_simplification":
    case "risk_prevention":
    case "major_change":
      return true;
    case "stale_work":
    case "user_correction":
    case "skill_workshop":
    case "instruction_adherence":
    case "workflow_simplification":
    case "agent_minimization":
    case "capability_evolution":
    case "knowledge_hygiene":
    case "outcome_measurement":
      return false;
  }
}

function routeRequiresApproval(route: SelfImprovementRecommendationRoute): boolean {
  return (
    route.role === "builder" ||
    route.role === "memory_curator" ||
    route.role === "qa" ||
    route.role === "program_manager"
  );
}

export function buildSelfImprovementSafety(params: {
  category: SelfImprovementRecommendationCategory;
  route: SelfImprovementRecommendationRoute;
}): SelfImprovementRecommendationSafety {
  return {
    mode: "recommendation_only",
    mutationAllowed: false,
    requiresApproval: routeRequiresApproval(params.route),
    requiresTests: categoryRequiresTests(params.category),
    blockedActions: BLOCKED_ACTIONS,
  };
}
